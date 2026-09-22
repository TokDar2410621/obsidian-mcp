/**
 * « Impossible » n'est pas un livrable.
 *
 * Le defaut, dit par Darius mot pour mot : « quand je recois ca, impossible,
 * lien verrouille, aucun contenu capte, je dois faire quoi avec ? je dois
 * valider pour ne plus le voir ? ». Deux taches du coffre se sont terminees par
 * un constat d'impossibilite, puis ont ete rangees comme des livrables a
 * valider :
 *
 *  - 2026-08-31, « Appliquer ca pour gridar et Arivex » : la video Facebook
 *    jointe est derriere un mur de connexion, aucun transcript nulle part.
 *  - 2026-07-12, « Confirmer l'etat live des 3 outils Gridar » : le MCP Gridar
 *    refuse la permission a une session executeur non interactive.
 *
 * Les deux portent, ecrite par l'executeur le jour meme, la question precise
 * qui debloquerait tout. Personne ne l'a jamais lue : elle dormait dans le bloc
 * « ## Résultat » d'une fiche rangee en file de validation. Ce module la trouve
 * et la rend VERBATIM. Rien n'est redige ici.
 *
 * La porte est CONTRACTUELLE, pas devinee. `tache-worker/tache_worker.py:361`
 * impose verbatim a l'executeur : « SI UN PERIMETRE OU UN ACCES BLOQUE LA
 * LETTRE ... tu t'ARRETES et tu le dis dans le bloc RESULTAT (critere KO + la
 * question precise a poser a Darius) ». Le classifieur ne devine pas un
 * blocage, il lit la marque que l'executeur a l'ordre de poser.
 *
 * Mode de panne assume, fermeture par le haut. Si ce prompt change et cesse
 * d'imposer le critere KO, `classer` rend `bloque: false` et la tache retombe
 * dans le comportement d'aujourd'hui. Jamais de fermeture a tort, jamais de
 * question inventee.
 *
 * Pur : ni coffre, ni express, ni reseau.
 */

/** Pourquoi la tache est bloquee. Une seule porte aujourd'hui. */
export type MotifManque = 'critere-ko' | 'aucun';

export interface MatiereManquante {
  bloque: boolean;
  /** La question DEJA ECRITE par l'executeur, verbatim. Jamais generee ici. */
  question: string;
  /** Etiquette de trois mots pour le titre de la notification. */
  piece: string;
  motif: MotifManque;
}

/** Quand l'executeur a pose le critere KO sans paragraphe nomme ni resume. */
export const QUESTION_PAR_DEFAUT = 'Le travail est bloqué faute de matière.';

/** Etiquette de repli : la notification dit toujours ce qui manque. */
export const PIECE_PAR_DEFAUT = 'une précision';

/**
 * De quoi parle le blocage, en trois mots pour un ecran verrouille. Table de
 * motifs, jamais une reformulation : la question part entiere dans le corps.
 */
const PIECES: Array<[RegExp, string]> = [
  [/verrouill|mur de connexion|facebook|login/i, 'une capture du contenu'],
  [/permission|non accordable|inatteignable/i, 'une permission'],
  [/fichier.*(absent|introuvable)/i, 'le fichier'],
  [/secret|cl[ée] API|token/i, 'un accès'],
];

const normaliser = (chemin: string): string => (chemin ?? '').trim().replace(/\\/g, '/');

/**
 * Le DERNIER verdict `demande satisfaite` du bloc Resultat.
 *
 * Deux conventions opposees cohabitent dans ce meme bloc, et les confondre
 * casse la classification :
 *
 *  - `parseResultat` (validation-route.ts:290) prend la PREMIERE paire
 *    `resume:` / `livrables:`. C'est juste pour elles : la premiere ecrite est
 *    la bonne quand le bloc en porte deux.
 *  - le verdict, lui, exige la DERNIERE ligne `criteres:`. Une reprise empile
 *    une nouvelle paire, et c'est la derniere qui fait foi. Verifie sur
 *    09-taches/2026-09-03-v-rifier-si-l-autopilote-gridar-tourne-encore-sur.md :
 *    son bloc Résultat porte deux lignes `criteres:`, la reprise dit OK.
 *
 * Ne pas « harmoniser » les deux. Le scope compte autant : ce verdict se lit
 * dans `## Résultat` UNIQUEMENT. La meme fiche du 2026-09-03 porte
 * `demande satisfaite KO` dans son `## Contrôle`, verdict d'une reprise
 * ANNULEE par les passes suivantes. Un grep sur le fichier entier la classerait
 * bloquee a tort, alors que le travail a bien ete fait.
 *
 * Les separateurs toleres sont ceux qui existent vraiment : releve sur les 341
 * fiches du coffre, 124 occurrences, `demande satisfaite OK` (81), `=OK` (17),
 * `: OK` (15), `Demande satisfaite: KO` (2), ` : OK` (2), `= OK` (1).
 */
export function verdictCriteres(blocResultat: string): 'ok' | 'ko' | 'absent' {
  const lignes = [...(blocResultat ?? '').matchAll(/^\s*crit[eè]res?\s*:\s*(.+)$/gim)];
  if (lignes.length === 0) return 'absent';
  const derniere = lignes[lignes.length - 1][1];
  const verdict = /demande\s+satisfaite\s*[:=]?\s*\b(KO|OK|PARTIEL)\b/i.exec(derniere);
  if (!verdict) return 'absent';
  return verdict[1].toLowerCase() === 'ko' ? 'ko' : 'ok';
}

/**
 * Le paragraphe nomme que l'executeur a l'ordre d'ecrire, rendu VERBATIM.
 *
 * Les trois formulations sont celles trouvees dans le coffre : « Question
 * précise à poser à Darius : », « Question à poser à Darius : », « Blocage à
 * remonter à Darius : ». L'ancre de debut de ligne est ce qui protege du faux
 * positif mesure : la ligne `livrables:` de la fiche du 2026-08-31 contient
 * « question précise pour Darius » en plein milieu.
 */
export function questionPosee(blocResultat: string): string | null {
  const re =
    /^\s*\**\s*(?:Question\s+pr[ée]cise[^:\n]*|Question\s+[àa]\s+poser[^:\n]*|Blocage\s+[àa]\s+remonter[^:\n]*)\s*:\s*(.+(?:\n(?!\s*\n)[^\n]+)*)/im;
  const m = re.exec(blocResultat ?? '');
  if (!m) return null;
  return m[1].trim() || null;
}

/**
 * Corroborant : la tache n'a produit qu'elle-meme. JAMAIS suffisant seul.
 *
 * Mesure faite avant d'ecrire une ligne : sur les 29 taches `a-valider` du
 * jour, ce signal remonte trois fiches, dont
 * 2026-09-03-v-rifier-si-l-autopilote-gridar-tourne-encore-sur.md, qui est un
 * VRAI livrable (`criteres: demande satisfaite OK verdict rendu et justifié`).
 * Livrer la-dessus transformerait un travail fait en question posee. La porte
 * reste le critere KO ; ceci ne sert qu'a expliquer une decision, jamais a la
 * prendre.
 */
export function livrablesAutoReferents(blocResultat: string, cheminTache: string): boolean {
  const brut = (/^\s*livrables\s*:\s*(.+)$/im.exec(blocResultat ?? '')?.[1] ?? '').trim();
  const entrees = brut
    .split('|')
    .map(p => p.replace(/\([^)]*\)\s*$/, '').trim())
    .filter(Boolean);
  if (entrees.length === 0) return false;
  const tache = normaliser(cheminTache);
  return entrees.every(e => normaliser(e) === tache);
}

export interface TacheAClasser {
  path: string;
  resume: string;
  livrables: string[];
  /** Le bloc `## Résultat` BRUT. Absent : la tache n'est jamais bloquee. */
  resultatBrut?: string;
}

/**
 * Bloquee faute de matiere, ou pas.
 *
 * `question` est soit le verbatim du paragraphe nomme, soit exactement le
 * `resume:` de l'executeur. Le cerveau ne redige rien : c'est la regle de la
 * piece manquante deja ecrite et jamais livree.
 */
export function classer(tache: TacheAClasser): MatiereManquante {
  const bloc = tache?.resultatBrut ?? '';
  const bloque = verdictCriteres(bloc) === 'ko';
  const resume = (tache?.resume ?? '').trim();
  const question = questionPosee(bloc) ?? (resume || QUESTION_PAR_DEFAUT);
  const dans = `${question} ${resume}`;
  const piece = PIECES.find(([motif]) => motif.test(dans))?.[1] ?? PIECE_PAR_DEFAUT;
  return { bloque, question, piece, motif: bloque ? 'critere-ko' : 'aucun' };
}
