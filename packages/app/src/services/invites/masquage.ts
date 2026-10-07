/**
 * Masquage des donnees personnelles dans ce que Dan sert (decision de Darius
 * du 2026-10-07, apres l'audit du coffre reel : Q14).
 *
 * Ce que l'audit a trouve HORS des zones cachees : 1 151 courriels, 389
 * telephones, 102 adresses (surtout des prospects et des clients dans
 * 05-projects), des numeros de permis d'etudes et de travail, un lien de
 * reunion avec son code. Montrer les coordonnees de tiers a des amis sans
 * leur consentement, c'est aussi un probleme de Loi 25.
 *
 * Le masquage s'applique a CHAQUE lecture de Dan (read-note, recherche,
 * index, graphe, synapses, skills) : ce qui est masque n'atteint jamais un
 * LLM. Il est volontairement large : masquer un faux positif (un nombre qui
 * ressemble a un telephone) ne coute rien ; laisser passer un vrai numero, si.
 *
 * Ce qu'il ne sait PAS faire : reconnaitre un recit personnel. C'est pour ca
 * que Journal/ et 03-daily/ sont des zones cachees, et que leur savoir sort
 * par distillation validee par Darius.
 */

const MASQUE = {
  courriel: '[courriel masqué]',
  telephone: '[téléphone masqué]',
  adresse: '[adresse masquée]',
  codePostal: '[code postal masqué]',
  numero: '[numéro masqué]',
  reunion: '[lien de réunion masqué]',
  code: '[code masqué]',
  secret: '[secret masqué]',
};

/** Cles et jetons connus, au cas ou un secret aurait ete colle dans une note. */
const SECRETS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abps]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /x-access-token:[^@\s]+@/g,
];

const COURRIEL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Liens de visioconference (ils portent souvent un code d'acces). */
const REUNION =
  /\bhttps?:\/\/(?:meet\.google\.com|[\w-]+\.zoom\.us|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|meet\.jit\.si)\/\S*/gi;

/** `mot de passe : xxx`, `passcode xxx`, `code secret : xxx` : on garde l'etiquette. */
const VALEUR_SECRETE =
  /\b((?:mot de passe|mdp|password|passwd|passcode|pass code|code secret|code d'accès|code d'acces|pin)\s*[:=]?\s*)(?!\[)(?=[^\s,;)]*[\d!@#$%^&*_+=~])([^\s,;)]{3,})/gi;

/** Codes a usage unique : `code 281112`, `OTP : 281112`. */
const CODE_UNIQUE = /\b((?:code|otp|verification code|code de vérification)[^\n\d]{0,25})\d{4,8}\b/gi;

/** Adresse civique : numero + type de voie + nom. */
const ADRESSE =
  /\b\d{1,5}[A-Za-z]?,?\s+(?:rue|avenue|av\.|boulevard|boul\.|blvd|chemin|ch\.|rang|place|route|montée|montee|côte|cote|street|st\.|road|rd\.|drive|dr\.)\s+[^\n,;()]{2,40}/gi;

/** Code postal canadien. */
const CODE_POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi;

/**
 * Numeros de documents : permis (F314502963, EB123456789), passeport,
 * identifiants a prefixe lettre + 6 chiffres ou plus. Et tout numero
 * annonce par son etiquette (UCI, NAS, passeport, permis...).
 */
const DOCUMENT = /\b[A-Z]{1,3}\d{6,12}\b/g;
const DOCUMENT_ETIQUETE =
  /\b((?:UCI|IUC|NAS|SIN|passeport|passport|permis(?: d'études| d'etudes| de travail)?(?: coop)?|n° de dossier|numéro de dossier|numero de dossier|client id)\s*(?:no|n°|#|:)?\s*)(?=[A-Z0-9 -]*\d{4})([A-Z0-9][A-Z0-9 -]{5,20}[A-Z0-9])/gi;

/**
 * Telephones, tous formats : une suite de chiffres et de separateurs qui
 * compte de 9 a 15 chiffres. Les dates ISO et les heures ne sont pas des
 * telephones.
 */
const CANDIDAT_TELEPHONE = /(?<![\w@/#.\-[])\+?\(?\d[\d\s().-]{7,22}\d(?![\w-])/g;

function estTelephone(candidat: string): boolean {
  const chiffres = candidat.replace(/\D/g, '');
  if (chiffres.length < 9 || chiffres.length > 15) return false;
  const propre = candidat.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(propre)) return false; // date ISO
  if (/^\d{4}\s+\d{4}$/.test(propre)) return false; // deux annees
  return true;
}

/**
 * Les brouillons de prospection portent leur texte ENCODE dans des liens
 * `mailto:` (`%0A`, `%20`) : la signature de Darius (telephone, code postal)
 * y echappait a tous les motifs (audit du 2026-10-07, 66 numeros). On decode
 * ces segments avant de masquer ; le lien n'est plus cliquable, le savoir
 * reste lisible.
 */
const SEGMENT_ENCODE = /[^\s<>()[\]"']*(?:%[0-9A-Fa-f]{2}[^\s<>()[\]"']*){3,}/g;

function decoderSegments(texte: string): string {
  return texte.replace(SEGMENT_ENCODE, segment => {
    try {
      return decodeURIComponent(segment.replace(/\+/g, ' '));
    } catch {
      return segment.replace(/%[0-9A-Fa-f]{2}/g, ' ');
    }
  });
}

export function masquerDonneesPersonnelles(texte: string): string {
  let t = decoderSegments(texte);
  for (const motif of SECRETS) t = t.replace(motif, MASQUE.secret);
  t = t.replace(REUNION, MASQUE.reunion);
  t = t.replace(COURRIEL, MASQUE.courriel);
  t = t.replace(VALEUR_SECRETE, (_m, etiquette: string) => `${etiquette}${MASQUE.code}`);
  t = t.replace(CODE_UNIQUE, (_m, etiquette: string) => `${etiquette}${MASQUE.code}`);
  t = t.replace(DOCUMENT_ETIQUETE, (_m, etiquette: string) => `${etiquette}${MASQUE.numero}`);
  t = t.replace(DOCUMENT, MASQUE.numero);
  t = t.replace(ADRESSE, MASQUE.adresse);
  t = t.replace(CODE_POSTAL, MASQUE.codePostal);
  t = t.replace(CANDIDAT_TELEPHONE, c => (estTelephone(c) ? MASQUE.telephone : c));
  return t;
}
