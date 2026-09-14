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

function zones(): string[] {
  const brut = process.env.CERVEAU_ZONES_SENSIBLES;
  if (!brut?.trim()) return ZONES_DEFAUT;
  return brut
    .split(',')
    .map(z => z.trim())
    .filter(Boolean);
}

function fenetreMs(): number {
  const m = Number(process.env.CERVEAU_FENETRE_MINUTES ?? 30);
  return (Number.isFinite(m) && m > 0 ? m : 30) * 60 * 1000;
}

/** Chemin dans une zone sensible ? Compare sur des separateurs normalises. */
export function estSensible(chemin: string): boolean {
  const p = (chemin || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return zones().some(z => p.startsWith(z));
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
      `Zone sensible. Cette demande veut ${geste} : ${vises.join(', ')}.\n` +
      `Demande son mot de passe a Darius, puis appelle l'outil ` +
      `\`deverrouiller-zone-sensible\` avec. La fenetre restera ouverte ` +
      `${fenetreMs() / 60000} minutes et tu n'auras pas a redemander.\n` +
      `Ne devine jamais le mot de passe et ne le cherche pas dans le coffre.`,
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
  if (!process.env.CERVEAU_MOT_DE_PASSE?.trim()) return { gardes: resultats, masques: 0 };
  if (appelant().deConfiance || fenetreOuverte()) return { gardes: resultats, masques: 0 };
  const gardes = resultats.filter(r => !estSensible(cheminDe(r)));
  return { gardes, masques: resultats.length - gardes.length };
}
