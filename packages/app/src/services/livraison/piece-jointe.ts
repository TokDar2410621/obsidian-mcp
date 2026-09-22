import { estSensible } from '@/services/securite/zones-sensibles';
import type { Signeur } from '@/services/livraison/lien-signe';

/**
 * Choisir CE QUI vaut d'etre montre, et en faire une piece jointe ntfy.
 *
 * Pur : aucune dependance au coffre, a express ou au reseau. Le signeur arrive
 * en parametre, l'existence du fichier est verifiee par l'appelant.
 *
 * Le defaut repare. `annoncer()` prenait `livrables[livrables.length - 1]`,
 * c'est-a-dire la DERNIERE entree de la liste. Or l'executeur ecrit le produit
 * principal en PREMIER et la fiche de tache en dernier. Exemple reel du coffre :
 *
 *   02-knowledge/carrousels/DcIccFMj.md | 01-raw/transcripts/x.md
 *   | 01-raw/images/slide-01-cover.jpg | 09-taches/2026-08-21-analyse.md
 *
 * L'annonce pointait donc presque toujours vers la fiche de la tache elle-meme,
 * c'est-a-dire vers rien.
 *
 * Et `livrables:` n'est pas une liste de fichiers du coffre. Verifie dedans :
 * « commit 66e11b3 », « commits 3e77042a, 9d135193 », « backend/views.py »
 * (autre depot), « https://ar-fit-demo.vercel.app/pdp », des chemins absolus
 * Windows de l'ere PC2. On choisit donc par extension CONNUE, jamais par
 * position.
 */

/** Ce qui se montre le mieux sur un telephone, du meilleur au moins bon. */
export const RANGS: Record<string, number> = {
  // Une image s'AFFICHE dans la notification : c'est la demande litterale.
  png: 0,
  jpg: 0,
  jpeg: 0,
  gif: 0,
  webp: 0,
  pdf: 1,
  html: 2,
  md: 3,
  py: 4,
  js: 4,
  ts: 4,
  json: 4,
  csv: 4,
  txt: 4,
  patch: 4,
};

/** Ce que ntfy peut AFFICHER en vignette, plutot que pousser en blob. */
const AFFICHABLES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']);

const MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  html: 'text/html',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  // py, js, ts, txt, patch : servis en texte brut. Jamais un type executable
  // par le navigateur dans l'origine du serveur.
};

/** Chemin normalise : separateurs unifies, espaces de bord retires. */
const normaliser = (chemin: string): string => (chemin ?? '').trim().replace(/\\/g, '/');

/** L'extension en minuscules, sans le point. Vide si le nom n'en porte pas. */
export function extensionDe(chemin: string): string {
  const base = normaliser(chemin).split('/').pop() ?? '';
  const point = base.lastIndexOf('.');
  if (point <= 0) return '';
  return base.slice(point + 1).toLowerCase();
}

/**
 * Le type MIME servi par la route. Table locale de treize lignes plutot qu'un
 * import de `mcp/storage-tool-registrations.ts` : son `inferMime` n'y est pas
 * exporte, et ce module traine le SDK MCP entier dans une route HTTP.
 */
export function typeMime(chemin: string): string {
  return MIMES[extensionDe(chemin)] ?? 'text/plain; charset=utf-8';
}

/**
 * Un chemin que la route a le droit de servir depuis le coffre.
 *
 * Refuse, dans cet ordre : vide ; absolu Windows ; commencant par « / » ou
 * « ~ » ; contenant « : » (lecteur ou flux NTFS) ; contenant « .. » ; une URL ;
 * sans extension connue ; une zone sensible.
 *
 * Accepte les ESPACES, verifies dans le coffre :
 * « 05-projects/Projet 3D Web Animation/04-web-animation-patterns.md ».
 * `validNotePath` (validation-route.ts:700, regex `[^\s]*`) les refuse, ce qui
 * rend deja ces livrables en texte mort dans /revue. On ne reproduit pas ce
 * defaut ici.
 */
export function cheminServable(chemin: string): boolean {
  const p = normaliser(chemin);
  if (!p) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('~')) return false;
  if (p.includes(':')) return false;
  if (p.includes('..')) return false;
  if (/^https?:\/\//i.test(p)) return false;
  if (!(extensionDe(p) in RANGS)) return false;
  if (estSensible(p)) return false;
  return true;
}

/**
 * Les livrables servables, du meilleur au moins bon.
 *
 * Retire la fiche de la tache elle-meme et tout `09-taches/*` : une fiche de
 * tache n'est jamais le produit. Tri stable par rang, puis par ordre
 * d'apparition, parce que l'executeur ecrit le produit principal en premier.
 */
export function classerLivrables(livrables: string[], cheminTache: string): string[] {
  const tache = normaliser(cheminTache);
  const vus = new Set<string>();
  const retenus: { p: string; rang: number; i: number }[] = [];
  (livrables ?? []).forEach((brut, i) => {
    const p = normaliser(brut);
    if (!p || p === tache) return;
    if (p.startsWith('09-taches/')) return;
    if (!cheminServable(p)) return;
    if (vus.has(p)) return;
    vus.add(p);
    retenus.push({ p, rang: RANGS[extensionDe(p)], i });
  });
  retenus.sort((a, b) => a.rang - b.rang || a.i - b.i);
  return retenus.map(r => r.p);
}

export interface PieceJointe {
  /** URL que ntfy va chercher pour AFFICHER la vignette. */
  attach?: string;
  /** Nom montre a cote de la piece jointe. */
  filename?: string;
  /** URL ouverte au tap sur le corps de la notification. */
  click?: string;
  /** Le livrable retenu, pour le nommer dans le message et le journal. */
  chemin?: string;
  raison?: 'aucun-livrable' | 'aucun-servable' | 'signature-indisponible';
}

/** Le nom de fichier seul, jamais le chemin complet. */
export function nomFichier(chemin: string): string {
  return normaliser(chemin).split('/').pop() ?? chemin;
}

/**
 * Construit la piece a partir d'un chemin DEJA choisi et verifie existant.
 *
 * Une image ou un PDF prennent `attach` : le telephone affiche la vignette.
 * Un `.md`, un `.html`, un `.py` n'en prennent PAS : ntfy pousserait un blob a
 * telecharger, ce qui ne montre rien. Ils prennent seulement `click`, vers la
 * page de vue qui, elle, sait les rendre.
 *
 * `livrablesBruts` sert uniquement a distinguer « la tache n'a rien produit »
 * de « elle a produit quelque chose qu'on ne sait pas servir ».
 */
export function construirePieceJointe(
  chemin: string | null,
  signeur: Signeur | null,
  livrablesBruts: string[] = [],
): PieceJointe {
  if (!chemin) {
    return { raison: livrablesBruts.length === 0 ? 'aucun-livrable' : 'aucun-servable' };
  }
  // Double garde : on ne demande JAMAIS de signature pour un chemin refuse.
  // Un lien signe vers une zone sensible est pire qu'une route ouverte, il
  // survit hors de toute fenetre de deverrouillage.
  if (!cheminServable(chemin)) return { raison: 'aucun-servable' };
  if (!signeur) return { raison: 'signature-indisponible' };
  const lien = signeur(chemin);
  if (!lien) return { raison: 'signature-indisponible' };

  const affichable = AFFICHABLES.has(extensionDe(chemin));
  return {
    ...(affichable ? { attach: lien.brut, filename: nomFichier(chemin) } : {}),
    click: lien.vue,
    chemin,
  };
}
