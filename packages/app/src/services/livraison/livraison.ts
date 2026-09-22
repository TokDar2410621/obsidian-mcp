import type { VaultManager } from '@/services/vault-manager';
import { readAllFiles } from '@/services/vault-manager';
import type { Notification, NotificationAction, NotifyPusher } from '@/services/notify/notifier';
import { parseResultat, section } from '@/server/local/validation-route';
import type { Signeur } from '@/services/livraison/lien-signe';
import {
  classerLivrables,
  construirePieceJointe,
  nomFichier,
} from '@/services/livraison/piece-jointe';
import type { EtatLivraison, Voie } from '@/services/livraison/etat';
import { aujourdhui, ecrireEtat, lireEtat } from '@/services/livraison/etat';
import { classer } from '@/services/livraison/matiere-manquante';
import { poserQuestion } from '@/services/livraison/question';
import { logger } from '@/utils/logger';

/**
 * Livraison : ce que le cerveau vient de produire ARRIVE a Darius, ou se ferme
 * tout seul. C'est l'etape qui manquait.
 *
 * Le premier defaut repare (2026-09-21). Une tache donnee a 23h17 etait
 * executee et controlee CONFORME a 23h35, et rien ne l'a dit. La seule
 * notification de livrable de la journee vient du balayage de relance, dont le
 * metier est de signaler ce qui STAGNE : il exige un age minimum d'un jour,
 * trie du plus ancien au plus recent et n'annonce QUE le premier. Ce soir-la il
 * a donc annonce une tache du 12 juillet, avec 81 autres derriere. Un travail
 * reussi en dix-huit minutes etait structurellement inannoncable : plus il
 * reussit vite, moins il a de chances d'etre vu.
 *
 * Le second defaut repare, le meme jour. Le livrable n'arrivait toujours pas :
 * la notification portait son CHEMIN. Sept taches ont ete faites et controlees
 * sans que Darius voie jamais leur produit : « je n'ai jamais recu le hero pour
 * voir physiquement », « je n'ai jamais recu l'affiche qui a ete refaite ». La
 * notification porte maintenant le FICHIER, par un lien signe a duree limitee
 * (lien-signe.ts, piece-jointe.ts), et son `click` ouvre la page qui le montre.
 * Les boutons Valider et Rejeter passent dans `actions`, ou ils ne perdent
 * rien : c'est ce qui libere `click` pour le livrable sans elargir d'un metre
 * la circulation du CAPTURE_TOKEN.
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
 *
 * Le troisieme defaut repare : « impossible » n'est pas un livrable. Une tache
 * qui echoue faute de MATIERE (lien verrouille, permission refusee, fichier
 * absent) ne rejoint plus la file de validation : elle prend le statut
 * `question-posee` et revient comme la question que l'executeur avait deja
 * ecrite, repondable en une dictee. Voir matiere-manquante.ts et question.ts.
 */

const TACHES_DIR = '09-taches';

/** Les sources qui veulent dire « Darius a demande ca ». */
const DEMANDES_DE_DARIUS = new Set(['telephone', 'chat', 'darius', 'triage', 'revue']);

/**
 * Plafonds par passage. Mesure faite sur le coffre a l'instant T : un etat vide
 * face aux 34 taches `a-valider` du jour donnait 9 pushes ntfy d'affilee et 25
 * `writeFile` EAGER, donc 25 commit+push en rafale. C'est la tempete
 * documentee dans vault-manager.ts:106-109 (79 commits sur 141 en un jour, les
 * workers PC2 ont perdu leurs push trois jours de suite).
 *
 * L'amorcage plus bas desamorce ce premier tour ; ces plafonds sont la ceinture
 * pour une journee simplement chargee. Une tache au-dela du plafond n'est PAS
 * marquee vue : elle repasse au tick suivant, cinq minutes plus tard. Rien
 * n'est perdu. Surchargeables par LivraisonDeps, que http.ts alimente depuis
 * LIVRAISON_MAX_ANNONCES et LIVRAISON_MAX_FERMETURES.
 */
const MAX_ANNONCES = 3;
const MAX_FERMETURES = 10;

/**
 * Questions par passage. Deux taches du coffre entier sont concernees au
 * premier tour ; le plafond est la meme ceinture que les deux autres, pour le
 * jour ou une serie d'executions bute sur le meme acces manquant.
 */
const MAX_QUESTIONS = 3;

/** Au plus trois `fileExists` par annonce : chacun coute une synchro git. */
const MAX_VERIFS = 3;

/** Source absente ou inconnue : traitee comme une initiative du cerveau.
 *  C'est le comportement majoritaire (229 taches sur 350) et il est reversible :
 *  tout reste dans git et le digest en donne le lien. */
export function estDemandeDeDarius(source: string): boolean {
  return DEMANDES_DE_DARIUS.has(source.trim().toLowerCase());
}

export interface TacheFinie {
  path: string;
  titre: string;
  source: string;
  risque: string;
  resume: string;
  livrables: string[];
  /** La date `created:` du frontmatter, ou une chaine vide. */
  creee: string;
  /**
   * Le bloc `## Résultat` BRUT, tel que l'executeur l'a ecrit.
   *
   * `parseResultat` n'en garde que `resume` et `livrables` ; le classifieur de
   * matiere manquante a besoin du reste (la ligne `criteres:` et le paragraphe
   * « Question précise a poser a Darius »). Ne pas le retirer : c'est la
   * matiere premiere de l'aiguillage vers la voie question.
   */
  resultatBrut: string;
}

/**
 * L'aiguillage, en UNE fonction nommee plutot qu'un booleen inline.
 *
 * La voie `question` passe EN PREMIER, avant le test de source, et ce n'est pas
 * une preference de style. Mesure sur le coffre : la tache
 * `2026-07-12-confirmer-l-tat-live-des-3-outils-gridar` porte `source: cerveau`,
 * qui n'est pas dans DEMANDES_DE_DARIUS. Testee apres la source, une
 * impossibilite se fermerait SILENCIEUSEMENT en `validee` : une impossibilite
 * classee reussite, le pire des deux mondes. L'autre cas,
 * `2026-08-31-appliquer-ca-pour-gridar-et-arivex`, porte `source: telephone` et
 * partait en « Termine » avec pour livrable le fichier de tache lui-meme.
 *
 * Ne PAS resoudre un cas particulier en elargissant DEMANDES_DE_DARIUS a
 * `reponses`, `penseur` ou `claude` : cela contredit la regle de tri ecrite en
 * tete de fichier et casse le test qui fixe `estDemandeDeDarius('penseur')`.
 */
export function acheminer(tache: TacheFinie): Voie {
  if (classer(tache).bloque) return 'question';
  if (estDemandeDeDarius(tache.source) || tache.risque === 'validation-requise') return 'annoncer';
  return 'fermer';
}

export interface LivraisonDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  baseUrl?: string;
  token?: string | null;
  /**
   * Fabrique des liens signes vers les livrables. Null ou absent : le service
   * retombe sur son lien /revue, exactement comme avant, et rien ne casse.
   * Injecte plutot que lu dans l'environnement, pour que le test de
   * comportement reste hermetique.
   */
  signeur?: Signeur | null;
  maxAnnonces?: number;
  maxFermetures?: number;
  maxQuestions?: number;
}

export interface ResultatLivraison {
  /** Taches demandees par Darius, annoncees tout de suite. */
  annoncees: number;
  /** Initiatives du cerveau fermees sans bruit. */
  fermees: number;
  /** Taches inscrites SANS action au tout premier passage (amorcage). */
  amorcees: number;
  /** Taches bloquees faute de matiere, renvoyees en question a Darius. */
  questions: number;
}

const champ = (contenu: string, nom: string): string =>
  (new RegExp(`^${nom}\\s*:\\s*(.*)$`, 'm').exec(contenu)?.[1] ?? '').trim();

export class LivraisonService {
  constructor(private readonly deps: LivraisonDeps) {}

  private get maxAnnonces(): number {
    return this.deps.maxAnnonces ?? MAX_ANNONCES;
  }

  private get maxFermetures(): number {
    return this.deps.maxFermetures ?? MAX_FERMETURES;
  }

  private get maxQuestions(): number {
    return this.deps.maxQuestions ?? MAX_QUESTIONS;
  }

  /** Le lien de repli, quand aucun livrable n'est servable. */
  private lien(): string | undefined {
    const { baseUrl, token } = this.deps;
    if (!baseUrl || !token) return undefined;
    // Un BASE_URL termine par « / » produisait « //revue » (defaut de la
    // premiere version, corrige ici comme relance-sweep.ts:212 le fait deja).
    return `${baseUrl.replace(/\/+$/, '')}/revue?k=${encodeURIComponent(token)}`;
  }

  /** Valider / Rejeter / Revue dans la notification, calques sur relance-sweep. */
  private boutons(tache: TacheFinie): NotificationAction[] {
    const { baseUrl, token } = this.deps;
    if (!baseUrl || !token) return [];
    const racine = baseUrl.replace(/\/+$/, '');
    const k = encodeURIComponent(token);
    const t = encodeURIComponent(tache.path);
    return [
      { label: 'Valider', url: `${racine}/valide?k=${k}&t=${t}` },
      { label: 'Rejeter', url: `${racine}/rejette?k=${k}&t=${t}` },
      { label: 'Revue', url: `${racine}/revue?k=${k}` },
    ];
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
      const blocResultat = section(contenu, 'Résultat');
      const { resume, livrables } = parseResultat(blocResultat);
      out.push({
        path: rel,
        titre: (/^#\s+(.+)$/m.exec(contenu)?.[1] ?? rel.split('/').pop() ?? rel).trim(),
        source: champ(contenu, 'source'),
        risque: champ(contenu, 'risque'),
        resume,
        livrables,
        creee: (/^created\s*:\s*(\d{4}-\d{2}-\d{2})/m.exec(contenu)?.[1] ?? '').trim(),
        resultatBrut: blocResultat,
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

  /**
   * L'annonce, qui porte le livrable lui-meme.
   *
   * Le `fileExists` n'est pas decoratif : `livrables:` contient pour de vrai
   * des chemins d'AUTRES depots (`backend/sites_mgmt/views.py`) et des fichiers
   * non suivis par git, presents sur le PC qui les a produits et absents du
   * clone du serveur. On ne signe que ce qui existe vraiment.
   */
  private async annoncer(tache: TacheFinie): Promise<void> {
    const candidats = classerLivrables(tache.livrables, tache.path).slice(0, MAX_VERIFS);
    let choisi: string | null = null;
    for (const c of candidats) {
      if (await this.deps.vault.fileExists(c)) {
        choisi = c;
        break;
      }
    }
    const piece = construirePieceJointe(choisi, this.deps.signeur ?? null, tache.livrables);
    // Le NOM du livrable reste dans le message meme quand le fichier n'est pas
    // joignable : `08-auto/_notifications.md` est la memoire de ce que le
    // cerveau a pousse, et ntfy n'en garde que douze heures.
    const nomme = piece.chemin ?? candidats[0] ?? null;
    const lignes = [
      tache.resume || 'Le livrable est prêt et contrôlé.',
      ...(nomme ? [`Livrable : ${nomFichier(nomme)}`] : []),
      'Valider garde, Rejeter jette.',
    ];
    const click = piece.click ?? this.lien();
    const actions = this.boutons(tache);
    const notification: Notification = {
      title: `✅ Terminé : ${tache.titre.slice(0, 80)}`,
      message: lignes.join('\n'),
      priority: 4,
      tags: ['white_check_mark'],
      ...(piece.attach ? { attach: piece.attach, filename: piece.filename } : {}),
      ...(click ? { click } : {}),
      ...(actions.length ? { actions } : {}),
    };
    await this.deps.notify?.push(notification);
  }

  /**
   * Le tout premier passage n'agit sur rien d'autre que les questions : il
   * inscrit chaque tache `a-valider` deja presente, et sort.
   *
   * Sans cela, la mise en service partait en rafale sur tout l'historique. Et
   * surtout, elle FERMAIT silencieusement des taches anciennes dont la source
   * (`reponses`, `penseur`, `claude`) n'est pas dans DEMANDES_DE_DARIUS. Le `le`
   * d'une amorce vaut le `created:` reel de la fiche, pour que la peremption a
   * venir dispose de l'age vrai sans relire les fiches.
   */
  private amorcer(etat: EtatLivraison, finies: TacheFinie[]): number {
    let amorcees = 0;
    for (const tache of finies) {
      // Une tache deja traitee dans ce meme passage (une question posee) garde
      // sa voie : l'amorce ne repasse jamais par-dessus une action reelle.
      if (etat.traitees[tache.path]) continue;
      etat.traitees[tache.path] = { le: tache.creee, voie: 'amorce' };
      amorcees++;
    }
    return amorcees;
  }

  /**
   * Les impossibilites du premier passage, qui ne s'amorcent PAS.
   *
   * L'amorcage existe pour eviter une rafale d'annonces et de commits sur tout
   * l'historique, pas pour enterrer les deux taches que ce chantier repare.
   * Elles sont deux dans le coffre entier, sous le meme plafond que le reste :
   * aucune rafale possible, et la question que l'executeur a ecrite le 31 aout
   * cesse enfin de dormir.
   */
  private async questionsDuPremierPassage(
    etat: EtatLivraison,
    finies: TacheFinie[],
  ): Promise<number> {
    let questions = 0;
    const le = aujourdhui();
    for (const tache of finies) {
      if (questions >= this.maxQuestions) break;
      if (acheminer(tache) !== 'question') continue;
      try {
        await poserQuestion(this.deps, tache, classer(tache));
        etat.traitees[tache.path] = { le, voie: 'question' };
        questions++;
      } catch (error) {
        logger.warn('Livraison: question non posee', { path: tache.path, error: String(error) });
      }
    }
    return questions;
  }

  /**
   * Un passage : annonce ce que Darius a demande, ferme le reste.
   * Idempotent par l'etat : une tache livree ne repasse jamais.
   */
  async run(): Promise<ResultatLivraison> {
    const etat = await lireEtat(this.deps.vault);
    const vierge = Object.keys(etat.traitees).length === 0;
    const dejaVues = new Set(Object.keys(etat.traitees));
    const finies = await this.tachesFinies(dejaVues);

    if (vierge) {
      const questions = await this.questionsDuPremierPassage(etat, finies);
      const amorcees = this.amorcer(etat, finies);
      if (amorcees + questions > 0) {
        await ecrireEtat(this.deps.vault, etat);
        logger.info('Livraison amorcee (premier passage)', { amorcees, questions });
      }
      return { annoncees: 0, fermees: 0, amorcees, questions };
    }

    let annoncees = 0;
    let fermees = 0;
    let questions = 0;
    const le = aujourdhui();

    for (const tache of finies) {
      const voie = acheminer(tache);
      if (voie === 'annoncer' && annoncees >= this.maxAnnonces) continue;
      if (voie === 'fermer' && fermees >= this.maxFermetures) continue;
      if (voie === 'question' && questions >= this.maxQuestions) continue;
      try {
        switch (voie) {
          case 'annoncer':
            await this.annoncer(tache);
            annoncees++;
            break;
          case 'fermer':
            await this.fermer(tache);
            fermees++;
            break;
          case 'question':
            // « Impossible » n'est pas un livrable : la tache quitte la file
            // de validation et revient comme une question repondable.
            await poserQuestion(this.deps, tache, classer(tache));
            questions++;
            break;
        }
        etat.traitees[tache.path] = { le, voie };
      } catch (error) {
        // Une tache qui echoue a etre livree n'est pas marquee vue : elle
        // repassera au prochain tour plutot que de disparaitre en silence.
        logger.warn('Livraison: echec sur une tache', { path: tache.path, error: String(error) });
      }
    }

    if (annoncees + fermees + questions > 0) {
      await ecrireEtat(this.deps.vault, etat);
      logger.info('Livraison done', { annoncees, fermees, questions });
    }
    return { annoncees, fermees, amorcees: 0, questions };
  }
}

export type { EtatLivraison, Voie } from '@/services/livraison/etat';
