import { AsyncLocalStorage } from 'async_hooks';

/**
 * Qui appelle, propage du middleware HTTP jusqu'au handler d'outil MCP.
 *
 * Le probleme a resoudre. Claude Code (le terminal de Darius), les workers et
 * le connecteur claude.ai frappent TOUS `/mcp` en HTTP, avec le meme client
 * OAuth : le serveur n'en a qu'un seul de configure. Rien ne les distingue a
 * l'arrivee. Or la garde des zones sensibles ne doit mordre que sur claude.ai.
 *
 * La distinction se cree donc par un SECOND jeton, dit de confiance
 * (`CERVEAU_JETON_LOCAL`), pose dans la config de Claude Code et des workers.
 * Le middleware compare le porteur presente a ce jeton et marque l'appel ; le
 * handler d'outil, loin en aval, lit la marque ici.
 *
 * AsyncLocalStorage plutot qu'une variable de module : le serveur traite des
 * requetes concurrentes, et une variable globale ferait fuiter le contexte
 * d'un appelant vers un autre. C'est precisement le genre de bug qui, sur une
 * garde de securite, ouvre la porte au lieu de la fermer.
 */
export interface ContexteAppelant {
  /** Vrai quand le porteur est le jeton local : Claude Code, workers, crons. */
  deConfiance: boolean;
  /** Etiquette pour les journaux : jamais le jeton lui-meme. */
  origine: 'local' | 'claude.ai';
}

const stockage = new AsyncLocalStorage<ContexteAppelant>();

export function avecAppelant<T>(ctx: ContexteAppelant, fn: () => T): T {
  return stockage.run(ctx, fn);
}

/**
 * Le contexte courant. Defaut PRUDENT : hors de tout contexte connu, on
 * considere l'appel comme non fiable. Une garde qui s'ouvre par defaut quand
 * elle ne sait pas n'est pas une garde.
 */
export function appelant(): ContexteAppelant {
  return stockage.getStore() ?? { deConfiance: false, origine: 'claude.ai' };
}

/** Le jeton local est-il configure ? Sans lui, aucun appel n'est de confiance. */
export function jetonLocalConfigure(): boolean {
  return Boolean(process.env.CERVEAU_JETON_LOCAL?.trim());
}

/**
 * Comparaison a temps constant du jeton presente au jeton local.
 * Une comparaison naive fuit la longueur et le prefixe par le temps de reponse.
 */
export function estJetonLocal(presente: string): boolean {
  const attendu = process.env.CERVEAU_JETON_LOCAL?.trim();
  if (!attendu || !presente) return false;
  if (attendu.length !== presente.length) return false;
  let diff = 0;
  for (let i = 0; i < attendu.length; i++) {
    diff |= attendu.charCodeAt(i) ^ presente.charCodeAt(i);
  }
  return diff === 0;
}
