import crypto from 'crypto';
import { appelant } from '@/services/securite/appelant';
import { logger } from '@/utils/logger';

/**
 * La garde des zones sensibles du coffre.
 *
 * Contrat decide par Darius le 2026-09-13 :
 *   - garde la LECTURE et la SUPPRESSION, jamais l'ECRITURE. Ajouter une note
 *     ne fait fuiter ni ne detruit rien ; en sortir une ou l'effacer, si.
 *   - ne mord que sur claude.ai. Claude Code, les workers et les crons passent
 *     (ils portent le jeton local, voir appelant.ts).
 *   - un deverrouillage ouvre une FENETRE, pas une demande par requete.
 *
 * Ce qu'elle protege vraiment, dit franchement. Le mot de passe transite par
 * la conversation, donc l'agent qui le recoit l'a. Il ne protege PAS de
 * l'agent. Il prouve qu'un HUMAIN est present : un cron, un worker, une tache
 * de fond ne peuvent pas taper un mot de passe. C'est un controle de presence,
 * pas un secret. Traiter le mot de passe comme jetable et le faire tourner.
 *
 * La garde vit ICI, dans le serveur, et jamais dans une consigne de prompt :
 * `00-personnel/` etait "propose-only" dans CLAUDE.md depuis des mois, ce qui
 * n'a jamais empeche personne d'y ecrire. Une regle qu'un agent peut oublier
 * n'est pas une garde.
 */

const ZONES_DEFAUT = ['00-personnel/', '04-people/', '01-raw/docs/', '01-raw/admin/'];

/**
 * Zones que Dan (l'instance invitee) ne montre JAMAIS, quel que soit
 * CERVEAU_ZONES_SENSIBLES. La variable d'env AJOUTE des zones, elle n'en
 * retire aucune : oublier de la poser ne doit jamais ouvrir le coffre.
 *
 * Decisions de Darius du 2026-10-07 :
 *   - `Personnes/` (spec « Cerveau invite et skills integres », Q4) ;
 *   - apres l'audit du coffre reel (Q14, Q15) : `Journal/` et `03-daily/`
 *     (recit personnel mele au savoir : le savoir en sort par distillation
 *     validee, jamais par ouverture du journal), `01-raw/` (captures brutes,
 *     numeros de documents d'immigration), `09-taches/` et `09-archive/`
 *     (taches et reponses passees).
 */
const ZONES_INVITE = [
  ...ZONES_DEFAUT,
  'Personnes/',
  'Journal/',
  '03-daily/',
  '01-raw/',
  '09-taches/',
  '09-archive/',
];

/**
 * Instance invitee (Dan) : lecture seule, aucun deverrouillage, filtrage
 * permanent. Lu a chaque appel pour que les tests puissent basculer.
 */
export function estModeInvite(): boolean {
  return (process.env.GUEST_MODE ?? '').trim().toLowerCase() === 'true';
}

/** Outils qui SORTENT de l'information du coffre. */
const OUTILS_LECTURE = new Set([
  'read-note',
  'read-notes',
  'get-file',
  'search-vault',
  'search-cerveau',
  'ask-cerveau',
  'list-files-in-dir',
]);

/** Outils qui DETRUISENT. */
const OUTILS_SUPPRESSION = new Set(['delete-note', 'delete-file']);

/**
 * Une zone ou un chemin ramene a une forme comparable : separateurs `/`, sans
 * `./` ni `/` en tete, sans segment vide, Unicode NFC. Une zone ecrite
 * `/Journal/`, `./Journal` ou `Journal\` designe le meme dossier que
 * `Journal/` : la rater en silence ouvrait ce que Darius croyait ferme.
 */
function normaliserChemin(chemin: string): string {
  return (chemin || '')
    .normalize('NFC')
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s.length > 0 && s !== '.')
    .join('/');
}

function zonesEnv(): string[] {
  const brut = process.env.CERVEAU_ZONES_SENSIBLES;
  if (!brut?.trim()) return [];
  return brut
    .split(',')
    .map(z => {
      const n = normaliserChemin(z.trim());
      // Le slash final d'origine compte : `Journal/` vise le dossier,
      // `Journal` tout ce qui commence par ce nom.
      return n && /[\\/]\s*$/.test(z) ? `${n}/` : n;
    })
    .filter(Boolean);
}

function zones(): string[] {
  if (estModeInvite()) return [...new Set([...ZONES_INVITE, ...zonesEnv()])];
  const env = zonesEnv();
  return env.length > 0 ? env : ZONES_DEFAUT;
}

function fenetreMs(): number {
  const m = Number(process.env.CERVEAU_FENETRE_MINUTES ?? 30);
  return (Number.isFinite(m) && m > 0 ? m : 30) * 60 * 1000;
}

/**
 * Chemin dans une zone sensible ? Compare sur des separateurs normalises.
 * Le dossier lui-meme compte aussi (`Personnes` sans slash final, tel que le
 * rend un listing de repertoires) : sinon son nom fuirait par une liste.
 */
export function estSensible(chemin: string): boolean {
  const brut = normaliserChemin(chemin);
  if (!brut) return false;
  // Dan ignore aussi la casse : `journal/` ne doit pas rouvrir `Journal/`.
  // L'instance perso garde la comparaison exacte qu'elle a toujours eue.
  const invite = estModeInvite();
  const p = invite ? brut.toLowerCase() : brut;
  return zones().some(zone => {
    const z = invite ? zone.toLowerCase() : zone;
    return p.startsWith(z) || `${p}/` === z;
  });
}

// --- la fenetre de deverrouillage ------------------------------------------

let ouverteJusqua = 0;

export function fenetreOuverte(): boolean {
  return Date.now() < ouverteJusqua;
}

export function minutesRestantes(): number {
  return Math.max(0, Math.ceil((ouverteJusqua - Date.now()) / 60000));
}

/** Referme immediatement. Sert au verrouillage manuel et aux tests. */
export function verrouiller(): void {
  ouverteJusqua = 0;
}

/**
 * Valide le mot de passe et ouvre la fenetre. Rend faux sans rien dire de
 * plus : distinguer "mauvais mot de passe" de "aucun mot de passe configure"
 * renseignerait un attaquant sur l'etat du systeme.
 */
export function deverrouiller(motDePasse: string): boolean {
  // Dan n'ouvre jamais ses zones, meme avec le bon mot de passe.
  if (estModeInvite()) return false;
  const attendu = process.env.CERVEAU_MOT_DE_PASSE?.trim();
  if (!attendu || !motDePasse) return false;
  const a = Buffer.from(attendu);
  const b = Buffer.from(motDePasse);
  // timingSafeEqual exige des longueurs egales : on hache pour les uniformiser
  // sans fuir la longueur du secret par une comparaison prealable.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  if (!crypto.timingSafeEqual(ha, hb)) {
    logger.warn('Zone sensible : mot de passe refuse', { origine: appelant().origine });
    return false;
  }
  ouverteJusqua = Date.now() + fenetreMs();
  logger.info('Zone sensible : fenetre ouverte', {
    minutes: minutesRestantes(),
    origine: appelant().origine,
  });
  return true;
}

// --- la garde ---------------------------------------------------------------

export interface Refus {
  refuse: true;
  message: string;
}

/**
 * Faut-il refuser cet appel ? Rend null quand l'appel passe.
 *
 * `chemins` : les chemins vises par l'appel. Pour une recherche, ils ne sont
 * pas connus a l'avance ; c'est le FILTRAGE DES RESULTATS qui protege alors
 * (voir filtrerResultats), pas ce refus. Refuser toute recherche parce qu'elle
 * POURRAIT toucher une zone sensible rendrait le coffre inutilisable.
 */
export function garder(outil: string, chemins: string[]): Refus | null {
  if (!process.env.CERVEAU_MOT_DE_PASSE?.trim()) return null; // garde desactivee
  if (appelant().deConfiance) return null; // Claude Code, workers, crons
  const concerne = OUTILS_LECTURE.has(outil) || OUTILS_SUPPRESSION.has(outil);
  if (!concerne) return null;
  const vises = chemins.filter(estSensible);
  if (vises.length === 0) return null;
  if (fenetreOuverte()) return null;

  const geste = OUTILS_SUPPRESSION.has(outil) ? 'supprimer' : 'lire';
  logger.warn('Zone sensible : appel refuse', { outil, vises: vises.length });
  return {
    refuse: true,
    message:
      `ZONE SENSIBLE. Cette demande veut ${geste} : ${vises.join(', ')}.\n\n` +
      `COMMENT DEMANDER LE MOT DE PASSE, dans cet ordre de preference :\n` +
      `1. Si tu disposes de l'outil AskUserQuestion, UTILISE-LE. C'est la ` +
      `consigne explicite de Darius (2026-09-13) : il veut une invite nette, ` +
      `pas une phrase noyee dans un paragraphe. Pose une seule question, ` +
      `header court (ex. "Mot de passe"), et laisse-le repondre par le champ ` +
      `libre : un mot de passe ne se choisit pas dans une liste.\n` +
      `2. Sinon seulement, demande-le en clair dans ta reponse, sur sa propre ` +
      `ligne, et arrete-toi la : n'enchaine sur aucune autre action.\n\n` +
      `Puis appelle \`deverrouiller-zone-sensible\` avec ce qu'il a repondu. ` +
      `La fenetre restera ouverte ${fenetreMs() / 60000} minutes : tu n'auras ` +
      `pas a redemander a chaque requete.\n\n` +
      `INTERDIT : deviner le mot de passe, le chercher dans le coffre ou dans ` +
      `l'historique, ou reprendre celui d'une conversation precedente. ` +
      `Demande-le a Darius, maintenant.`,
  };
}

/**
 * Retire les entrees sensibles d'un lot de resultats de recherche.
 *
 * Une recherche ne nomme pas ses chemins a l'avance : la garder par refus
 * bloquerait toute recherche du coffre. On la laisse donc passer et on retire
 * ce qui ne doit pas sortir, en le DISANT (un masquage muet ferait croire que
 * la note n'existe pas, et Darius chercherait un bug la ou il y a une regle).
 */
export function filtrerResultats<T>(
  resultats: T[],
  cheminDe: (r: T) => string,
): { gardes: T[]; masques: number } {
  if (estModeInvite()) {
    // Ni mot de passe, ni fenetre, ni jeton de confiance : le filtre mord
    // toujours. L'index invite ne contient deja aucune zone cachee ; ceci est
    // la seconde ceinture si un index perso etait charge par erreur.
    const gardes = resultats.filter(r => !estSensible(cheminDe(r)));
    return { gardes, masques: resultats.length - gardes.length };
  }
  if (!process.env.CERVEAU_MOT_DE_PASSE?.trim()) return { gardes: resultats, masques: 0 };
  if (appelant().deConfiance || fenetreOuverte()) return { gardes: resultats, masques: 0 };
  const gardes = resultats.filter(r => !estSensible(cheminDe(r)));
  return { gardes, masques: resultats.length - gardes.length };
}
