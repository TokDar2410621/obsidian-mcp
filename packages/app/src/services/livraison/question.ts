import crypto from 'node:crypto';
import type { VaultManager } from '@/services/vault-manager';
import type { Notification, NotificationAction } from '@/services/notify/notifier';
import type { MatiereManquante } from '@/services/livraison/matiere-manquante';
import type { LivraisonDeps, TacheFinie } from '@/services/livraison/livraison';

/**
 * Une tache bloquee faute de matiere revient comme une QUESTION, pas comme un
 * livrable a valider.
 *
 * Ce que Darius refuse, mot pour mot : « je dois valider pour ne plus le
 * voir ? ». Une impossibilite rangee en file de validation lui demande un tap
 * sur du vide. Elle doit lui demander la seule piece qui manque, et repartir
 * toute seule des qu'il l'a donnee.
 *
 * Trois choix expliques ici parce qu'ils sont le coeur du correctif :
 *
 * 1. Un statut NEUF, `question-posee`, jamais `echouee`. Une tache `echouee`
 *    affiche « Relancer » dans /revue (validation-route.ts:875), qui la passe
 *    en `approuvee`, et `tache_worker.py:571` fait
 *    `runnable = statut == "approuvee" or (statut == "proposee" and risque ==
 *    "sans-risque")`. Relancer une tache dont le lien Facebook est toujours
 *    verrouille la refait echouer a l'identique. `question-posee` est INERTE
 *    cote worker par cette meme ligne : la tache ne peut pas repartir tant que
 *    la piece manque. C'est exactement la propriete voulue.
 *
 * 2. La reponse se donne par la voie qui existe deja : `/capture/app?k=...&
 *    prefill=pk:%20`, construite par morning-brief.ts:386 et honoree par
 *    capture-route.ts:184. Meme route, meme porte, meme jeton : la nouveaute
 *    est la REFERENCE de tache glissee dans le prefill, pour que la reponse se
 *    rattache enfin a quelque chose. Aujourd'hui `09-taches/_reponses.md`
 *    porte « [reponse-libre] je n'ai pas la piece d'identite de mon garant a
 *    jour (capture) » : le champ fichier vaut litteralement `capture`, donc la
 *    reponse ne debloque rien. Rien de nouveau ne circule, le CAPTURE_TOKEN
 *    n'est pas elargi d'un metre.
 *
 * 3. La reponse va dans `## Demande`, pas dans un coin. `tache_worker.py:608`
 *    passe a l'executeur le fichier ENTIER et son protocole (ligne 410) lui
 *    ordonne de relire la Demande mot a mot. Une piece manquante rangee
 *    ailleurs rejouerait l'echec a l'identique.
 */

const TACHES_DIR = '09-taches';

/** Le statut d'une tache qui attend une reponse de Darius, et rien d'autre. */
export const STATUT_QUESTION = 'question-posee';

/** Le statut ou la tache retourne des que la piece manquante est arrivee. */
export const STATUT_REPRISE = 'proposee';

/**
 * L'identite courte d'une tache, pour tenir dans un prefill dicte a la voix.
 * Derivee du chemin : sans etat, donc rien a desynchroniser, et aucune
 * ecriture dans un fichier d'etat partage.
 */
export function refTache(chemin: string): string {
  return crypto.createHash('sha256').update(chemin ?? '').digest('hex').slice(0, 8);
}

/** Ce que le bouton « Répondre » met dans la zone de dictee. */
export function prefillQuestion(ref: string): string {
  return `pk: [t:${ref}] `;
}

/**
 * Separe la reference du texte dicte. L'espace apres le crochet est souvent
 * avale par la dictee du telephone : `\s*` et non `\s`.
 */
export function extraireRef(texte: string): { ref: string | null; texte: string } {
  const brut = texte ?? '';
  const m = /^\s*\[t:([0-9a-fA-F]{8})\]\s*/.exec(brut);
  if (!m) return { ref: null, texte: brut.trim() };
  return { ref: m[1].toLowerCase(), texte: brut.slice(m[0].length).trim() };
}

/** Remplace la valeur de `statut:` du frontmatter, comme flipTaskStatus. */
function remplacerStatut(contenu: string, vers: string): string {
  return contenu.replace(/^(statut\s*:\s*).*$/m, `$1${vers}`);
}

/** La valeur courante de `statut:`, ou une chaine vide. */
function statutDe(contenu: string): string {
  return (/^statut\s*:\s*(.*)$/m.exec(contenu)?.[1] ?? '').trim();
}

const jour = (): string => new Date().toISOString().slice(0, 10);

export interface EntreeNotificationQuestion {
  titre: string;
  matiere: MatiereManquante;
  chemin: string;
  baseUrl?: string;
  token?: string | null;
}

/**
 * La notification-question. PURE : aucune lecture de coffre, aucun reseau.
 *
 * Le corps porte la question VERBATIM, et le `click` ouvre la dictee : c'est
 * le canal fiable. notifier.ts:26 documente que les boutons d'action iOS sont
 * capricieux chez Darius, donc ce qui compte ne vit jamais dans un bouton seul.
 *
 * Sans jeton : zero action, zero click, et la notification part quand meme.
 * Savoir qu'une question attend vaut mieux que le silence.
 */
export function notificationQuestion(a: EntreeNotificationQuestion): Notification {
  const title = `❓ Il me manque : ${a.matiere.piece}`.slice(0, 80);
  const message = [
    a.titre,
    '',
    a.matiere.question,
    '',
    'Réponds en vocal : un tap sur Répondre.',
  ].join('\n');
  const base: Notification = { title, message, priority: 4, tags: ['question'] };

  // `livraison.lien()` d'avant ne normalisait pas le baseUrl et produisait
  // « //revue » sur un BASE_URL termine par « / ». Jamais deux fois.
  const racine = (a.baseUrl ?? '').replace(/\/+$/, '');
  const jeton = a.token ?? '';
  if (!racine || !jeton) return base;

  const k = encodeURIComponent(jeton);
  const t = encodeURIComponent(a.chemin);
  const repondre = `${racine}/capture/app?k=${k}&prefill=${encodeURIComponent(prefillQuestion(refTache(a.chemin)))}`;
  // Trois au maximum : c'est la limite ntfy. Aucun bouton « Valider » : c'est
  // precisement le geste que Darius refuse de faire sur une impossibilite.
  const actions: NotificationAction[] = [
    { label: 'Répondre', url: repondre },
    { label: 'Abandonner', url: `${racine}/rejette?k=${k}&t=${t}` },
    { label: 'Revue', url: `${racine}/revue?k=${k}` },
  ];
  return { ...base, click: repondre, actions };
}

/**
 * Pose la question et sort la tache de la file de validation.
 *
 * UNE seule ecriture : deux `writeFile` valent deux commit et deux push, la
 * tempete documentee dans vault-manager.ts:106-109. L'ecriture eager est
 * assumee ici : deux taches du coffre entier sont concernees, aucune rafale
 * n'est possible.
 *
 * L'ordre (ecrire, puis pousser) est volontaire. Si le push echoue, la tache
 * est deja sortie de la file de validation et reste visible dans /revue comme
 * question posee : Darius la voit quand meme. L'ordre inverse risquerait une
 * question poussee deux fois, ce qui est plus bruyant que ce qu'on repare.
 */
export async function poserQuestion(
  deps: LivraisonDeps,
  tache: TacheFinie,
  matiere: MatiereManquante,
): Promise<void> {
  const contenu = await deps.vault.readFile(tache.path);
  const suivant = remplacerStatut(contenu, STATUT_QUESTION);
  if (suivant !== contenu) await deps.vault.writeFile(tache.path, suivant);
  await deps.notify?.push(
    notificationQuestion({
      titre: tache.titre,
      matiere,
      chemin: tache.path,
      baseUrl: deps.baseUrl,
      token: deps.token,
    }),
  );
}

/**
 * Le chemin de la tache designee par une reference, ou null.
 *
 * Sans etat : la reference se recalcule depuis les chemins presents. Rien a
 * perdre, rien a desynchroniser, et surtout aucune ecriture dans
 * `08-auto/_relances-state.json` (read-modify-write complet en
 * relance-sweep.ts:361) ni dans `08-auto/_livraison-state.json`.
 */
export async function resoudreRef(vault: VaultManager, ref: string): Promise<string | null> {
  const cible = (ref ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(cible)) return null;
  let fichiers: string[] = [];
  try {
    fichiers = await vault.listFiles(TACHES_DIR);
  } catch {
    return null;
  }
  for (const brut of fichiers) {
    const rel = brut.replace(/\\/g, '/');
    if (!rel.endsWith('.md')) continue;
    if ((rel.split('/').pop() as string).startsWith('_')) continue;
    if (refTache(rel) === cible) return rel;
  }
  return null;
}

/**
 * Insere la ligne a la FIN de la section `## Demande`, la ou l'executeur lit.
 */
function insererSousDemande(contenu: string, ligne: string): string {
  const entete = /^##\s+Demande\s*$/m.exec(contenu);
  if (!entete) return `${contenu.replace(/\s+$/, '')}\n\n## Demande\n\n${ligne}\n`;
  const debut = entete.index + entete[0].length;
  const suivant = /\n##\s+/.exec(contenu.slice(debut));
  const fin = suivant ? debut + suivant.index : contenu.length;
  const corps = contenu.slice(debut, fin).replace(/\s+$/, '');
  return `${contenu.slice(0, debut)}${corps}\n\n${ligne}\n${contenu.slice(fin)}`;
}

/**
 * Darius a repondu : la piece manquante entre dans la Demande et la tache
 * repart. Rend false sans rien ecrire si la tache n'attend plus de reponse,
 * ce qui la rend idempotente et l'empeche de ressusciter une tache rejetee
 * entre-temps.
 */
export async function reprendreApresReponse(
  vault: VaultManager,
  chemin: string,
  reponse: string,
): Promise<boolean> {
  let contenu: string;
  try {
    contenu = await vault.readFile(chemin);
  } catch {
    return false;
  }
  if (statutDe(contenu) !== STATUT_QUESTION) return false;
  const texte = (reponse ?? '').replace(/\s+/g, ' ').trim();
  if (!texte) return false;
  const avecReponse = insererSousDemande(contenu, `**Réponse de Darius (${jour()})** : ${texte}`);
  // UNE seule ecriture, portant les deux modifications.
  await vault.writeFile(chemin, remplacerStatut(avecReponse, STATUT_REPRISE));
  return true;
}
