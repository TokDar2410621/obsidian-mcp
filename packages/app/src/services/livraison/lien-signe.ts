import crypto from 'crypto';
import { estSensible } from '@/services/securite/zones-sensibles';

/**
 * Le lien signe qui porte un livrable jusqu'au telephone.
 *
 * Le defaut repare (2026-09-21). Sept taches ont ete executees, controlees, et
 * Darius n'a JAMAIS vu leur produit : un hero pour tokamdarius.ca, une affiche
 * LinkedIn refaite, un visuel genere. La notification portait une CHAINE de
 * caracteres qui ressemble a un chemin. Elle doit porter le FICHIER.
 *
 * Pourquoi un HMAC et pas le CAPTURE_TOKEN. Le jeton de capture circule deja
 * dans les liens ntfy et un audit l'a signale : on ne l'elargit pas a une
 * nouvelle surface. Une signature ne porte que trois champs, et AUCUN secret :
 * `f` le chemin, `e` l'expiration, `s` le digest. Le chemin est DANS le message
 * signe, donc une signature ne se rejoue jamais sur un autre fichier.
 *
 * Pourquoi une clef derivee et pas un secret tire au hasard au demarrage.
 * Railway redeploie souvent. Un secret regenere au boot transformerait en 404
 * toutes les pieces jointes deja envoyees : le telephone recharge la vignette
 * quand Darius ouvre la notification, des heures plus tard.
 *
 * Pourquoi une duree en JOURS. Meme raison : ntfy va chercher la piece jointe
 * a l'exterieur et le telephone la recharge a l'ouverture. Une TTL de quinze
 * minutes donne une image morte. Corollaire assume, ecrit noir sur blanc : sur
 * ntfy.sh public le fichier transite par un tiers. C'est la deuxieme raison de
 * refuser les zones sensibles, apres la premiere, qui est qu'un lien signe vers
 * une piece d'identite survit hors de toute fenetre de deverrouillage.
 */

/** Separation de domaine : une signature de livrable ne vaut nulle part ailleurs. */
const DOMAINE = 'livrable-v1';
const JOURS_DEFAUT = 7;
const SECONDES_PAR_JOUR = 86400;

export type Verdict = 'ok' | 'expire' | 'invalide' | 'desactive';

export interface LienSigne {
  /** Chemin relatif au coffre, ou cle bucket prefixee « bucket: ». */
  f: string;
  /** Expiration, epoch en secondes. */
  e: number;
  /** Digest hexadecimal. */
  s: string;
}

/** Fabrique les deux URL d'un livrable. Rend null quand le chemin est refuse. */
export type Signeur = (chemin: string) => { brut: string; vue: string } | null;

/**
 * Clef STABLE entre deux demarrages. `LIVRABLE_SECRET` si Darius veut la
 * separer, sinon derivee du `CAPTURE_TOKEN` avec separation de domaine.
 * Rend null quand aucune des deux n'existe : tout le dispositif s'eteint alors
 * proprement, la route ne se monte pas et la notification retombe sur /revue.
 */
export function secretLivrable(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const dedie = (env.LIVRABLE_SECRET ?? '').trim();
  if (dedie) return crypto.createHmac('sha256', dedie).update(DOMAINE).digest();
  const jeton = (env.CAPTURE_TOKEN ?? '').trim();
  if (jeton) return crypto.createHmac('sha256', jeton).update(DOMAINE).digest();
  return null;
}

/** Duree de vie d'un lien, en secondes. `LIVRAISON_LIEN_JOURS`, defaut 7. */
export function ttlSecondes(env: NodeJS.ProcessEnv = process.env): number {
  const jours = Number(env.LIVRAISON_LIEN_JOURS ?? JOURS_DEFAUT);
  const valides = Number.isFinite(jours) && jours > 0 ? jours : JOURS_DEFAUT;
  return Math.floor(valides * SECONDES_PAR_JOUR);
}

const digest = (secret: Buffer, chemin: string, e: number): string =>
  crypto.createHmac('sha256', secret).update(`${DOMAINE}\n${chemin}\n${e}`).digest('hex');

/**
 * Signe un chemin. Rend null sans secret, et null sur une zone sensible :
 * une zone sensible ne se signe JAMAIS, meme si la route revalide ensuite.
 * La signature prouve l'origine ; elle ne donne pas le droit.
 */
export function signer(
  chemin: string,
  maintenantMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): LienSigne | null {
  const secret = secretLivrable(env);
  if (!secret) return null;
  if (!chemin.trim()) return null;
  if (estSensible(chemin)) return null;
  const e = Math.floor(maintenantMs / 1000) + ttlSecondes(env);
  return { f: chemin, e, s: digest(secret, chemin, e) };
}

/**
 * Verdict d'un lien recu. Ordre volontaire : la SIGNATURE d'abord,
 * l'expiration ensuite. Un digest faux sur un lien perime rend « invalide »,
 * jamais « expire » : on ne renseigne pas un attaquant sur la validite d'un
 * digest qu'il n'a pas su fabriquer.
 */
export function verifier(
  chemin: string,
  e: string | number,
  s: string,
  maintenantMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Verdict {
  const secret = secretLivrable(env);
  if (!secret) return 'desactive';
  if (!chemin || !s) return 'invalide';
  const expiration = Number(e);
  if (!Number.isFinite(expiration)) return 'invalide';
  const attendu = Buffer.from(digest(secret, chemin, expiration), 'utf8');
  const recu = Buffer.from(s, 'utf8');
  // timingSafeEqual LEVE sur deux buffers de longueurs differentes : on teste
  // la longueur avant, comme github-webhook.ts:26.
  if (recu.length !== attendu.length) return 'invalide';
  if (!crypto.timingSafeEqual(recu, attendu)) return 'invalide';
  if (Math.floor(maintenantMs / 1000) > expiration) return 'expire';
  return 'ok';
}

/**
 * Le signeur injecte dans LivraisonService. Rend null sans secret, et le
 * service retombe alors sur son lien /revue d'avant : rien ne casse.
 *
 * Les deux URL partagent la MEME signature : `/livrable` sert les octets
 * (cible de `attach`), `/livrable/vue` montre la page (cible de `click`).
 */
export function creerSigneur(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Signeur | null {
  if (!secretLivrable(env)) return null;
  // Un BASE_URL termine par « / » produirait « //livrable ». Meme normalisation
  // que relance-sweep.ts:212.
  const racine = (baseUrl || '').replace(/\/+$/, '');
  return (chemin: string) => {
    const lien = signer(chemin, Date.now(), env);
    if (!lien) return null;
    const q = `f=${encodeURIComponent(lien.f)}&e=${lien.e}&s=${lien.s}`;
    return { brut: `${racine}/livrable?${q}`, vue: `${racine}/livrable/vue?${q}` };
  };
}
