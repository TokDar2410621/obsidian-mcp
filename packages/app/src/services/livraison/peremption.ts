import type { VaultManager } from '@/services/vault-manager';
import { readAllFiles } from '@/services/vault-manager';
import type { Notification, NotificationAction, NotifyPusher } from '@/services/notify/notifier';
import type { MarquePeremption } from '@/services/livraison/etat';
import { lireEtat, majEtat } from '@/services/livraison/etat';
import { logger } from '@/utils/logger';

/**
 * La peremption des livrables : un livrable non ouvert ne dort plus pour
 * toujours dans la file.
 *
 * Le defaut, mesure le 2026-09-21. La tache
 * `09-taches/2026-07-12-r-diger-le-message-pr-t-envoyer-au-garant-pour-sa.md`
 * attend sa validation depuis le 12 juillet. Le besoin est regle depuis des
 * semaines : la piece d'identite du garant n'est plus le sujet. Personne ne
 * s'en rend compte, et le systeme continue de l'annoncer tous les soirs, parce
 * que le balayage de relance trie du plus ancien au plus recent et n'annonce
 * que le premier (relance-sweep.ts, STALL_DAYS = 1, `stalled[0]`). La meme
 * tache de juillet revient chaque soir, avec 81 autres derriere. Mesure du
 * jour : 34 taches `a-valider` dans le coffre, 27 au-dela de 21 jours.
 *
 * Le remede, en une phrase : un livrable qui attend depuis plus de N jours
 * merite UNE question, pas un rappel. « Ceci date du 12 juillet, est-ce encore
 * utile ? », deux boutons, un tap. La regle du coffre
 * `04-systemes/regles/blocage-demander-pourquoi` dit que la question ne se
 * repose jamais deux fois : la marque `demandeeLe` la verrouille jusqu'a ce que
 * la tache sorte de la file ou qu'une reponse remette le compteur a zero.
 *
 * Trois choses bornees par passage, et pas une de plus :
 *
 *  1. UNE question, sur le plus vieux livrable au-dela du seuil.
 *  2. Au plus `LIVRAISON_PEREMPTION_MAX` archivages, sur les livrables dont la
 *     question est restee sans reponse pendant la periode de grace. Le silence
 *     vaut reponse, et c'est reversible : la fiche reste, git garde tout, le
 *     statut se repasse a la main.
 *  3. La purge des marques devenues sans objet.
 *
 * Le statut de sortie est `archivee`, un nom NEUF, et ce choix est le coeur du
 * correctif cote lecteurs : `listPendingTasks` (validation-route.ts) teste une
 * LISTE BLANCHE de statuts, donc `archivee` sort de /revue, du brief du matin
 * et de la relance sans une seule ligne de filtrage ajoutee. `rejetee` mentirait
 * sur la qualite du travail ; `echouee` est cable partout et son bouton
 * « Relancer » renverrait la tache au chef pour rien.
 *
 * Ce module est une FEUILLE : il n'importe ni `livraison.ts` ni
 * `validation-route.ts`. C'est `validation-route.ts` qui l'importe pour ses deux
 * routes, et l'import inverse fabriquerait un cycle. Les deux expressions
 * regulieres dont il a besoin (le bloc `## Résultat`, la ligne `resume:`) sont
 * donc recopiees ici, exactement comme `relance-sweep.ts:273` recopie deja
 * celle du bloc Resultat plutot que de l'importer.
 */

const TACHES_DIR = '09-taches';

/** Le statut d'un livrable sorti de la file faute d'interet. */
export const STATUT_ARCHIVEE = 'archivee';

/** Trois semaines sans un regard : le livrable n'est plus chaud. */
const JOURS_DEFAUT = 21;

/** Une semaine de silence apres la question vaut reponse. */
const GRACE_DEFAUT = 7;

/** Plafond d'archivages par passage : un writeFile vaut un commit et un push. */
const MAX_DEFAUT = 5;

const MOIS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

const RESULTAT_RE = /##\s*Résultat\s*\n([\s\S]*?)(?=\n##\s|$)/i;
const HORODATAGE_RE = /\*\*(\d{4}-\d{2}-\d{2})/g;
const CREATED_RE = /^created\s*:\s*(\d{4}-\d{2}-\d{2})/m;
const DATE_NOM_RE = /(?:^|\/)(\d{4}-\d{2}-\d{2})-/;
const STATUT_RE = /^statut\s*:\s*(.*)$/m;
const RESUME_RE = /^\s*resume\s*:\s*(.+)$/im;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lecture d'environnement A L'APPEL, jamais au chargement du module (patron de
 * `capture-link-sweep.ts:80-83`). Lue au chargement, la valeur se fige : les
 * tests ne pourraient plus changer le seuil, et Railway exigerait un
 * redeploiement pour un simple reglage.
 */
function entier(nom: string, defaut: number, min: number, max: number): number {
  const brut = (process.env[nom] ?? '').trim();
  if (!/^\d+$/.test(brut)) return defaut;
  const n = Number(brut);
  if (!Number.isFinite(n) || n < min || n > max) return defaut;
  return n;
}

/** Jours d'attente au-dela desquels un livrable merite sa question. */
export function joursPeremption(): number {
  return entier('LIVRAISON_PEREMPTION_JOURS', JOURS_DEFAUT, 1, 365);
}

/** Jours de silence apres la question avant que le silence vaille reponse. */
export function joursGrace(): number {
  return entier('LIVRAISON_PEREMPTION_GRACE', GRACE_DEFAUT, 0, 90);
}

function maxArchives(): number {
  return entier('LIVRAISON_PEREMPTION_MAX', MAX_DEFAUT, 1, 50);
}

/**
 * `LIVRAISON_PEREMPTION_SILENCE=off` neutralise le seul changement de
 * comportement reel de ce chantier (un livrable qui quitte la file sans que
 * Darius ait tape), sans rien couper d'autre : la question continue de partir.
 */
function silenceArchive(): boolean {
  return (process.env.LIVRAISON_PEREMPTION_SILENCE ?? '').trim().toLowerCase() !== 'off';
}

function jourMs(iso: string): number | null {
  const m = ISO_RE.test(iso ?? '') ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

/** Jours pleins entre deux AAAA-MM-JJ. 0 si l'une des deux est illisible. */
export function joursEntre(depuis: string, jour: string): number {
  const a = jourMs(depuis);
  const b = jourMs(jour);
  if (a === null || b === null) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/** '2026-07-12' rendu « 12 juillet 2026 ». Tableau local, pas d'Intl : le
 *  serveur tourne avec une locale non garantie et la prose doit etre stable. */
export function formaterDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const mois = MOIS[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${mois} ${m[1]}`;
}

/**
 * Depuis quand ce livrable attend. La plus RECENTE du dernier horodatage du
 * bloc `## Résultat` et du `created:` du frontmatter.
 *
 * Pourquoi la plus recente des deux, verifie sur le coffre :
 * `2026-07-12-r-sous-tu-as-enfin-tout-envoy-finditnow...md` porte
 * `created: 2026-07-12` et un Resultat du 2026-07-21 (tache relancee, elle
 * n'attend que depuis le 21) ; trois taches de septembre portent
 * `created: 2026-09-02` et un Resultat du 2026-09-01 (decalage UTC de
 * l'executeur, elles n'attendent pas depuis la veille de leur creation).
 * Prendre le maximum traite les deux cas et ne vieillit jamais un livrable a
 * tort.
 *
 * Replis successifs : la date en tete du nom de fichier, puis `repli` (le `le`
 * de l'etat de livraison), puis `null`. JAMAIS la date du jour par defaut :
 * une date inventee perime un livrable neuf ou rajeunit un vieux.
 *
 * Divergence assumee avec la feuille de route, qui prevoyait de dater depuis
 * l'etat. Insuffisant : l'amorcage de la livraison inscrit les 34 taches
 * existantes au jour du deploiement, donc la tache du garant redeviendrait agee
 * de zero jour ce jour-la. La NOTE est la source primaire ; l'etat n'est qu'un
 * dernier repli.
 */
export function dateDattente(contenu: string, path: string, repli?: string): string | null {
  const bloc = RESULTAT_RE.exec(contenu ?? '')?.[1] ?? '';
  let horodatage: string | null = null;
  for (const m of bloc.matchAll(HORODATAGE_RE)) {
    if (horodatage === null || m[1] > horodatage) horodatage = m[1];
  }
  const created = CREATED_RE.exec(contenu ?? '')?.[1] ?? null;
  const dates = [horodatage, created].filter((d): d is string => Boolean(d));
  if (dates.length) return dates.reduce((a, b) => (a > b ? a : b));
  const nom = DATE_NOM_RE.exec(path ?? '')?.[1];
  if (nom) return nom;
  return repli && ISO_RE.test(repli) ? repli : null;
}

/**
 * Le statut d'une fiche, c'est sa PREMIERE ligne `statut:`, et rien d'autre.
 *
 * Mesure sur le coffre (2026-09-22) : cinq fiches de juillet portent plusieurs
 * lignes `statut:`, restes d'un executeur qui empilait au lieu de remplacer.
 * `09-taches/2026-07-11-donne-suite-a-cet-insight-du-penseur-de-nuit-contr.md`
 * en porte SIX, dont `a-valider` en derniere position, alors que sa vraie
 * valeur est `validee`, en tete. Un simple test de presence les classerait
 * toutes les cinq en attente, et la peremption finirait par archiver du travail
 * deja valide.
 *
 * `listPendingTasks` et `flipTaskStatus` lisent tous les deux la PREMIERE
 * occurrence : ce module juge exactement comme eux, sinon la file vue par la
 * peremption cesse d'etre la file vue par Darius.
 */
export function estAValider(contenu: string): boolean {
  const m = STATUT_RE.exec(contenu ?? '');
  return !!m && m[1].trim() === 'a-valider';
}

/**
 * La ligne deposee au `## Journal` de la tache archivee. Zero em-dash : un hook
 * git bloque le commit, et le serveur du coffre sanitise a l'ecriture.
 */
export function ligneJournal(
  cause: 'silence' | 'reponse',
  depuis: string,
  jour: string,
  demandeeLe?: string,
): string {
  if (cause === 'reponse') return `[peremption ${jour}] Archivée sur ta réponse : plus utile.`;
  const question = demandeeLe ? `la question du ${demandeeLe}` : 'la question posée';
  const attente = depuis ? ` depuis le ${formaterDate(depuis)}` : '';
  return (
    `[peremption ${jour}] Archivée : ce livrable attendait${attente} et ${question} est restée ` +
    `sans réponse. Rien n'est perdu : repasse le statut à a-valider pour la revoir.`
  );
}

/**
 * Archive une fiche : le statut bascule ET la ligne de journal entre, en UNE
 * chaine de sortie, donc un seul `writeFile`, donc un seul commit.
 *
 * Rend `null` quand la fiche ne porte plus `statut: a-valider`. C'est la course
 * avec un tap de Darius entre la lecture groupee et l'ecriture : dans ce cas on
 * ne reecrit rien du tout, plutot que d'ecraser sa decision par la notre.
 */
export function archiver(contenu: string, ligne: string): string | null {
  const m0 = STATUT_RE.exec(contenu ?? '');
  if (!m0 || m0[1].trim() !== 'a-valider') return null;
  const avecStatut =
    contenu.slice(0, m0.index) +
    `statut: ${STATUT_ARCHIVEE}` +
    contenu.slice(m0.index + m0[0].length);
  const entree = `- ${ligne}`;
  // `[ \t]*$` et non `\s*$` : en multiligne, `\s*` avale le saut de ligne et
  // la ligne de journal atterrit une ligne trop bas.
  const m = /^##[ \t]+Journal[ \t]*$/m.exec(avecStatut);
  if (!m) return `${avecStatut.replace(/\n+$/, '')}\n\n${entree}\n`;
  const fin = m.index + m[0].length;
  return `${avecStatut.slice(0, fin)}\n${entree}${avecStatut.slice(fin)}`;
}

/**
 * « Encore utile » : la marque `demandeeLe` disparait et le compteur repart de
 * `utileLe`. Ecriture paresseuse via l'etat de livraison, seul proprietaire du
 * fichier : ne JAMAIS ecrire dans `08-auto/_relances-state.json`, dont
 * `RelanceSweepService.saveState` fait un read-modify-write complet.
 */
export async function marquerEncoreUtile(
  vault: VaultManager,
  path: string,
  jour: string,
): Promise<void> {
  await majEtat(vault, etat => {
    etat.peremption ??= {};
    etat.peremption[path] = { utileLe: jour };
  });
}

export interface LivrableDormant {
  path: string;
  titre: string;
  resume: string;
  /** AAAA-MM-JJ : depuis quand la fiche attend. */
  depuis: string;
  ageJours: number;
}

export interface ResultatPeremption {
  /** Taches `a-valider` regardees pendant le passage. */
  examines: number;
  /** Celles au-dela du seuil. */
  dormants: number;
  /** Le chemin sur lequel la question est partie, ou null. */
  demandee: string | null;
  /** Les chemins archives pendant ce passage. */
  archivees: string[];
}

export interface PeremptionDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  baseUrl?: string;
  token?: string | null;
  /** Horloge injectable (precedent : `retours.ts:64-66`). Sans elle, aucun test
   *  de vieillissement n'est ecrivable sans faux timers. */
  now?: () => Date;
}

const champ = (contenu: string, re: RegExp): string => (re.exec(contenu)?.[1] ?? '').trim();

export class PeremptionService {
  constructor(private readonly deps: PeremptionDeps) {}

  private jour(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString().slice(0, 10);
  }

  /** Aucun bouton sans jeton, et aucun parametre autre que `k` et `t` : ce
   *  chantier n'elargit d'un metre la circulation du CAPTURE_TOKEN. */
  private liens(path: string): { click?: string; actions: NotificationAction[] } {
    const { baseUrl, token } = this.deps;
    if (!baseUrl || !token) return { actions: [] };
    const racine = baseUrl.replace(/\/+$/, '');
    const k = encodeURIComponent(token);
    const t = encodeURIComponent(path);
    return {
      // Il doit pouvoir relire la fiche AVANT de trancher : /note accepte deja
      // un chemin de tache.
      click: `${racine}/note?k=${k}&t=${t}`,
      actions: [
        { label: 'Non, archive', url: `${racine}/archive?k=${k}&t=${t}` },
        { label: 'Encore utile', url: `${racine}/encore?k=${k}&t=${t}` },
        { label: 'Revue', url: `${racine}/revue?k=${k}` },
      ],
    };
  }

  private lienRevue(): string | undefined {
    const { baseUrl, token } = this.deps;
    if (!baseUrl || !token) return undefined;
    return `${baseUrl.replace(/\/+$/, '')}/revue?k=${encodeURIComponent(token)}`;
  }

  /** La population du balayage : les `a-valider`, et rien d'autre.
   *
   *  `echouee` est HORS PERIMETRE, volontairement : c'est le metier de la
   *  relance, et son bouton « Relancer » a un sens que « archiver » n'a pas.
   *  `question-posee` non plus : elle attend une reponse, pas une decision. */
  private async population(
    jour: string,
    marques: Record<string, MarquePeremption>,
    replis: Record<string, string>,
  ): Promise<{ dormants: LivrableDormant[]; vus: Set<string>; examines: number }> {
    const vide = { dormants: [], vus: new Set<string>(), examines: 0 };
    let fichiers: string[] = [];
    try {
      fichiers = await this.deps.vault.listFiles(TACHES_DIR);
    } catch {
      return vide;
    }
    const candidats = [
      ...new Set(
        fichiers
          .map(f => f.replace(/\\/g, '/').replace(/^\/+/, ''))
          // Prefixage defensif : certains doubles de coffre rendent des cles
          // nues plutot que des chemins complets.
          .map(f => (f.startsWith(`${TACHES_DIR}/`) ? f : `${TACHES_DIR}/${f}`)),
      ),
    ].filter(rel => rel.endsWith('.md') && !(rel.split('/').pop() as string).startsWith('_'));
    if (candidats.length === 0) return vide;
    // UNE lecture groupee pour tout le lot : une seule synchro git.
    const contenus = await readAllFiles(this.deps.vault, candidats);

    const dormants: LivrableDormant[] = [];
    const vus = new Set<string>();
    let examines = 0;
    for (const [rel, contenu] of contenus) {
      if (!estAValider(contenu)) continue;
      examines++;
      vus.add(rel);
      const depuis = dateDattente(contenu, rel, replis[rel]);
      if (!depuis) continue;
      const marque = marques[rel];
      // Une reponse « encore utile » fait repartir le compteur de SA date.
      const effectif = marque?.utileLe && marque.utileLe > depuis ? marque.utileLe : depuis;
      dormants.push({
        path: rel,
        titre: (/^#\s+(.+)$/m.exec(contenu)?.[1] ?? rel.split('/').pop() ?? rel).trim(),
        resume: champ(contenu, RESUME_RE),
        depuis,
        ageJours: joursEntre(effectif, jour),
      });
    }
    return { dormants, vus, examines };
  }

  private questionner(
    livrable: LivrableDormant,
    autres: number,
    archivees: number,
  ): Notification {
    const seuil = joursPeremption();
    const { click, actions } = this.liens(livrable.path);
    const lignes = [
      `Ce livrable attend ta décision depuis le ${formaterDate(livrable.depuis)} (${livrable.ageJours} jours).`,
      ...(livrable.resume ? [`« ${livrable.resume.slice(0, 180)} »`] : []),
      `Non, archive : il quitte la file. Encore utile : je redemande dans ${seuil} jours.`,
      ...(autres > 0 ? [`(${autres} autre(s) livrable(s) dorment aussi.)`] : []),
      ...(archivees > 0 ? [`${archivees} livrable(s) archivé(s) ce soir, faute de réponse.`] : []),
    ];
    return {
      title: `Encore utile ? ${livrable.titre.slice(0, 70)}`,
      message: lignes.join('\n'),
      // Un menage n'est pas une urgence : la relance est a 4, la peremption
      // reste en dessous.
      priority: 3,
      tags: ['hourglass'],
      ...(click ? { click } : {}),
      ...(actions.length ? { actions } : {}),
    };
  }

  /** Le compte rendu du mandat autonome : le cerveau agit seul sur du
   *  reversible, mais il le DIT. */
  private compteRendu(titres: string[]): Notification {
    const click = this.lienRevue();
    const lignes = [
      `${titres.length} livrable(s) ont quitté la file : la question était restée sans réponse.`,
      ...titres.slice(0, 5).map(t => `• ${t.slice(0, 70)}`),
      'Rien n’est perdu : les fiches restent dans le coffre.',
    ];
    return {
      title: 'Ménage des livrables',
      message: lignes.join('\n'),
      priority: 2,
      tags: ['broom'],
      ...(click ? { click } : {}),
    };
  }

  /**
   * Un passage. Une question au plus, `LIVRAISON_PEREMPTION_MAX` archivages au
   * plus, UNE notification au plus.
   */
  async run(): Promise<ResultatPeremption> {
    const vault = this.deps.vault;
    const jour = this.jour();
    const etat = await lireEtat(vault);
    const marques: Record<string, MarquePeremption> = { ...(etat.peremption ?? {}) };
    const replis: Record<string, string> = {};
    for (const [chemin, entree] of Object.entries(etat.traitees)) {
      if (entree.le) replis[chemin] = entree.le;
    }

    const { dormants, vus, examines } = await this.population(jour, marques, replis);
    const seuil = joursPeremption();
    const grace = joursGrace();
    const perimes = dormants.filter(d => d.ageJours >= seuil);

    // A archiver : la question est partie, la grace est ecoulee, aucune reponse
    // n'est venue depuis. Le plus ancien d'abord.
    const archivables = dormants
      .filter(d => {
        const m = marques[d.path];
        if (!m?.demandeeLe) return false;
        if (m.utileLe && m.utileLe >= m.demandeeLe) return false;
        return joursEntre(m.demandeeLe, jour) >= grace;
      })
      .sort((a, b) => b.ageJours - a.ageJours || a.depuis.localeCompare(b.depuis));

    const archivees: string[] = [];
    const titres: string[] = [];
    if (silenceArchive()) {
      for (const d of archivables) {
        if (archivees.length >= maxArchives()) break;
        try {
          // Relecture juste avant l'ecriture : entre la lecture groupee et
          // maintenant, Darius a pu taper /valide depuis son telephone.
          const frais = await vault.readFile(d.path);
          const suivant = archiver(
            frais,
            ligneJournal('silence', d.depuis, jour, marques[d.path]?.demandeeLe),
          );
          if (suivant === null) continue;
          await vault.writeFile(d.path, suivant);
          archivees.push(d.path);
          titres.push(d.titre);
          delete marques[d.path];
        } catch (error) {
          // Une fiche qui resiste n'empeche pas les suivantes.
          logger.warn('Peremption: archivage echoue', { path: d.path, error: String(error) });
        }
      }
    }

    // La question : le plus ancien candidat, et lui seul. `demandeeLe` la
    // verrouille ensuite : elle ne se repose jamais deux fois.
    const candidat = perimes
      .filter(d => !marques[d.path]?.demandeeLe && !archivees.includes(d.path))
      .sort((a, b) => b.ageJours - a.ageJours || a.depuis.localeCompare(b.depuis))[0];
    let demandee: string | null = null;
    if (candidat) {
      demandee = candidat.path;
      marques[candidat.path] = { ...(marques[candidat.path] ?? {}), demandeeLe: jour };
    }

    // AU PLUS UNE notification par passage.
    if (candidat) {
      await this.deps.notify?.push(
        this.questionner(candidat, Math.max(perimes.length - 1, 0), archivees.length),
      );
    } else if (titres.length > 0) {
      await this.deps.notify?.push(this.compteRendu(titres));
    }

    // Purge : une marque dont la tache n'est plus `a-valider` n'a plus d'objet.
    let purgees = 0;
    for (const cle of Object.keys(marques)) {
      if (!vus.has(cle)) {
        delete marques[cle];
        purgees++;
      }
    }

    if (demandee !== null || archivees.length > 0 || purgees > 0) {
      await majEtat(vault, e => {
        if (Object.keys(marques).length) e.peremption = marques;
        else delete e.peremption;
      });
    }

    return { examines, dormants: perimes.length, demandee, archivees };
  }
}
