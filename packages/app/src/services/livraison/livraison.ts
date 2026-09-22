import type { VaultManager } from '@/services/vault-manager';
import { readAllFiles, writeStateFile } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import { parseResultat, section } from '@/server/local/validation-route';
import { logger } from '@/utils/logger';

/**
 * Livraison : ce que le cerveau vient de produire arrive a Darius, ou se ferme
 * tout seul. C'est l'etape qui manquait.
 *
 * Le defaut repare (2026-09-21). Une tache donnee a 23h17 etait executee et
 * controlee CONFORME a 23h35, et rien ne l'a dit. La seule notification de
 * livrable de la journee vient du balayage de relance, dont le metier est de
 * signaler ce qui STAGNE : il exige un age minimum d'un jour, trie du plus
 * ancien au plus recent et n'annonce QUE le premier. Ce soir-la il a donc
 * annonce une tache du 12 juillet, avec 81 autres derriere. Un travail reussi
 * en dix-huit minutes etait structurellement inannoncable : plus il reussit
 * vite, moins il a de chances d'etre vu.
 *
 * La regle de tri, et pourquoi elle n'est pas le risque. 225 taches ont ete
 * marquees validee sans qu'aucune ne soit lue : demander un tap sur chacune
 * n'a jamais rien verifie, ca a seulement consomme l'attention de Darius, qui
 * est la ressource la plus rare du systeme. Ce qui merite son attention n'est
 * donc pas « ce qui est risque » mais « ce qu'il a demande » :
 *
 *  - il l'a demandee (telephone, chat, capture triee, promotion en revue) :
 *    il attend la reponse. Notification immediate, et la tache reste en
 *    `a-valider` : c'est lui qui juge.
 *  - le cerveau se l'est donnee (penseur, sweeps, sondes) et le controleur a
 *    dit CONFORME : elle se ferme seule, sans bruit, et parait au digest du
 *    jour. Rien n'est bloque sur lui.
 *  - `validation-requise` : jamais de fermeture automatique. Si le geste
 *    valait un feu vert avant, son resultat vaut un regard apres.
 */

const TACHES_DIR = '09-taches';
const ETAT = '08-auto/_livraison-state.json';

/** Les sources qui veulent dire « Darius a demande ca ». */
const DEMANDES_DE_DARIUS = new Set(['telephone', 'chat', 'darius', 'triage', 'revue']);

/** Source absente ou inconnue : traitee comme une initiative du cerveau.
 *  C'est le comportement majoritaire (229 taches sur 350) et il est reversible :
 *  tout reste dans git et le digest en donne le lien. */
export function estDemandeDeDarius(source: string): boolean {
  return DEMANDES_DE_DARIUS.has(source.trim().toLowerCase());
}

export interface EtatLivraison {
  version: 1;
  /** Chemins deja livres (notifies ou fermes), pour ne jamais les repasser. */
  traitees: string[];
}

export interface TacheFinie {
  path: string;
  titre: string;
  source: string;
  risque: string;
  resume: string;
  livrables: string[];
}

export interface LivraisonDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  baseUrl?: string;
  token?: string | null;
}

export interface ResultatLivraison {
  /** Taches demandees par Darius, annoncees tout de suite. */
  annoncees: number;
  /** Initiatives du cerveau fermees sans bruit. */
  fermees: number;
}

const champ = (contenu: string, nom: string): string =>
  (new RegExp(`^${nom}\\s*:\\s*(.*)$`, 'm').exec(contenu)?.[1] ?? '').trim();

export class LivraisonService {
  constructor(private readonly deps: LivraisonDeps) {}

  private lien(): string | undefined {
    const { baseUrl, token } = this.deps;
    if (!baseUrl || !token) return undefined;
    return `${baseUrl}/revue?k=${encodeURIComponent(token)}`;
  }

  private async lireEtat(): Promise<EtatLivraison> {
    try {
      const brut = JSON.parse(await this.deps.vault.readFile(ETAT)) as Partial<EtatLivraison>;
      return { version: 1, traitees: Array.isArray(brut.traitees) ? brut.traitees.filter(t => typeof t === 'string') : [] };
    } catch {
      return { version: 1, traitees: [] };
    }
  }

  /** Les taches fraichement terminees, jamais encore livrees. */
  async tachesFinies(dejaVues: Set<string>): Promise<TacheFinie[]> {
    let fichiers: string[] = [];
    try {
      fichiers = await this.deps.vault.listFiles(TACHES_DIR);
    } catch {
      return [];
    }
    const candidats = fichiers
      .map(f => f.replace(/\\/g, '/'))
      .filter(rel => rel.endsWith('.md') && !(rel.split('/').pop() as string).startsWith('_'))
      .filter(rel => !dejaVues.has(rel));
    if (candidats.length === 0) return [];
    // Une seule synchronisation du coffre pour tout le lot (readAllFiles).
    const contenus = await readAllFiles(this.deps.vault, candidats);

    const out: TacheFinie[] = [];
    for (const [rel, contenu] of contenus) {
      if (champ(contenu, 'statut') !== 'a-valider') continue;
      const { resume, livrables } = parseResultat(section(contenu, 'Résultat'));
      out.push({
        path: rel,
        titre: (/^#\s+(.+)$/m.exec(contenu)?.[1] ?? rel.split('/').pop() ?? rel).trim(),
        source: champ(contenu, 'source'),
        risque: champ(contenu, 'risque'),
        resume,
        livrables,
      });
    }
    return out;
  }

  /** Ferme une tache sans bruit : le controleur a deja dit CONFORME. */
  private async fermer(tache: TacheFinie): Promise<void> {
    const contenu = await this.deps.vault.readFile(tache.path);
    const suivant = contenu.replace(/^statut\s*:\s*.+$/m, 'statut: validee');
    if (suivant === contenu) return;
    await this.deps.vault.writeFile(tache.path, suivant);
  }

  private async annoncer(tache: TacheFinie): Promise<void> {
    const lignes = [
      tache.resume || 'Le livrable est prêt et contrôlé.',
      ...(tache.livrables.length ? [`Livrable : ${tache.livrables[tache.livrables.length - 1]}`] : []),
      'Valider garde, Rejeter jette.',
    ];
    await this.deps.notify?.push({
      title: `✅ Terminé : ${tache.titre.slice(0, 80)}`,
      message: lignes.join('\n'),
      priority: 4,
      tags: ['white_check_mark'],
      ...(this.lien() ? { click: this.lien() } : {}),
    });
  }

  /**
   * Un passage : annonce ce que Darius a demande, ferme le reste.
   * Idempotent par l'etat : une tache livree ne repasse jamais.
   */
  async run(): Promise<ResultatLivraison> {
    const etat = await this.lireEtat();
    const dejaVues = new Set(etat.traitees);
    const finies = await this.tachesFinies(dejaVues);
    let annoncees = 0;
    let fermees = 0;

    for (const tache of finies) {
      // Un geste qui valait un feu vert avant vaut un regard apres.
      const sienne = estDemandeDeDarius(tache.source) || tache.risque === 'validation-requise';
      try {
        if (sienne) {
          await this.annoncer(tache);
          annoncees++;
        } else {
          await this.fermer(tache);
          fermees++;
        }
        dejaVues.add(tache.path);
      } catch (error) {
        // Une tache qui echoue a etre livree n'est pas marquee vue : elle
        // repassera au prochain tour plutot que de disparaitre en silence.
        logger.warn('Livraison: echec sur une tache', { path: tache.path, error: String(error) });
      }
    }

    if (annoncees + fermees > 0) {
      await writeStateFile(
        this.deps.vault,
        ETAT,
        JSON.stringify({ version: 1, traitees: [...dejaVues].slice(-500) }, null, 2),
      );
      logger.info('Livraison done', { annoncees, fermees });
    }
    return { annoncees, fermees };
  }
}
