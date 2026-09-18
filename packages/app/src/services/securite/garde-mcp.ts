import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { filtrerResultats, garder } from '@/services/securite/zones-sensibles';

/**
 * Pose la garde des zones sensibles sur TOUS les outils, en un seul endroit.
 *
 * Plutot que d'ajouter un test dans chacun des 19 handlers (et d'oublier le
 * vingtieme), on enveloppe `registerTool` : chaque outil enregistre passe par
 * la garde, y compris ceux qu'on ajoutera plus tard. C'est la meme lecon que
 * la Loi 33 du coffre : corriger le generateur, pas les instances.
 */

/** Champs d'arguments qui designent un chemin du coffre ou une cle du bucket. */
const CHAMPS_CHEMIN = [
  'path',
  'paths',
  'file_path',
  'source_path',
  'destination_path',
  'directory',
  'folder',
  'key',
];

/** Les chemins vises par un appel d'outil, quel que soit le nom du parametre. */
export function cheminsDe(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const o = args as Record<string, unknown>;
  const out: string[] = [];
  for (const champ of CHAMPS_CHEMIN) {
    const v = o[champ];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
  }
  return out;
}

/** Champs qui portent un chemin dans une ENTREE de resultat. */
const CHAMPS_RESULTAT = ['path', 'file', 'key', 'chemin'];

/** Le chemin que designe une entree de liste, ou '' si elle n'en designe aucun. */
function cheminDEntree(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    for (const champ of CHAMPS_RESULTAT) {
      const v = (x as Record<string, unknown>)[champ];
      if (typeof v === 'string' && v) return v;
    }
  }
  return '';
}

/**
 * Retire d'une sortie d'outil tout ce qui pointe vers une zone sensible.
 *
 * Pourquoi generique plutot qu'une liste d'outils : la garde d'entree ne mord
 * que sur les appels qui NOMMENT un chemin (read-note, delete-note). Une
 * recherche, une liste, un graphe, un digest n'en nomment aucun et passaient
 * donc toujours. Les inscrire un par un, c'est la liste qu'on oublie de tenir
 * a jour : `filtrerResultats` existait pour ce cas depuis le debut et n'etait
 * appelee par rien. On filtre donc la SORTIE de tous les outils, ici.
 */
export function filtrerSortie(donnees: unknown): { donnees: unknown; masques: number } {
  if (!donnees || typeof donnees !== 'object' || Array.isArray(donnees)) {
    return { donnees, masques: 0 };
  }
  const source = donnees as Record<string, unknown>;
  const sortie: Record<string, unknown> = { ...source };
  let masques = 0;

  for (const [cle, valeur] of Object.entries(source)) {
    if (!Array.isArray(valeur) || valeur.length === 0) continue;
    if (!valeur.some(v => cheminDEntree(v) !== '')) continue; // pas une liste de chemins
    const { gardes, masques: m } = filtrerResultats(valeur, cheminDEntree);
    if (m === 0) continue;
    sortie[cle] = gardes;
    masques += m;
    // Un compteur qui decrivait cette liste doit suivre, sinon la sortie se
    // contredit elle-meme (« 12 fichiers » au-dessus d'une liste de 9).
    for (const compteur of ['count', 'total', 'total_files', 'total_matches']) {
      if (typeof sortie[compteur] === 'number' && sortie[compteur] === valeur.length) {
        sortie[compteur] = gardes.length;
      }
    }
  }
  if (masques === 0) return { donnees, masques: 0 };
  sortie.masques_zone_sensible = masques;
  return { donnees: sortie, masques };
}

/** Applique le filtre de sortie a l'enveloppe MCP rendue par un handler. */
function filtrerEnveloppe(resultat: unknown): unknown {
  if (!resultat || typeof resultat !== 'object') return resultat;
  const env = resultat as Record<string, unknown>;
  if (env.isError || !env.structuredContent) return resultat;
  const { donnees, masques } = filtrerSortie(env.structuredContent);
  if (masques === 0) return resultat;
  return {
    ...env,
    structuredContent: donnees,
    // `content` porte le MEME objet serialise : le laisser intact rendrait le
    // filtrage inutile, le client lit surtout ce texte.
    content: [{ type: 'text' as const, text: JSON.stringify(donnees, null, 2) }],
  };
}

type Enregistreur = McpServer['registerTool'];

/**
 * Rend un McpServer dont `registerTool` enveloppe chaque handler.
 *
 * On ne mute pas l'instance d'origine : un Proxy laisse le serveur intact pour
 * tout le reste (ressources, prompts, cycle de vie), et n'intercepte que le
 * seul point qui nous interesse.
 */
export function serveurGarde(server: McpServer): McpServer {
  return new Proxy(server, {
    get(cible, prop, recepteur) {
      if (prop !== 'registerTool') return Reflect.get(cible, prop, recepteur);
      const original = Reflect.get(cible, prop, recepteur) as Enregistreur;
      const enveloppe: Enregistreur = ((nom: string, config: unknown, handler: unknown) => {
        const garde = async (args: unknown, extra: unknown) => {
          const refus = garder(nom, cheminsDe(args));
          if (refus) {
            return {
              content: [{ type: 'text' as const, text: refus.message }],
              isError: true,
            };
          }
          const resultat = await (handler as (a: unknown, e: unknown) => unknown)(args, extra);
          return filtrerEnveloppe(resultat);
        };
        return (original as unknown as (...a: unknown[]) => unknown).call(
          cible,
          nom,
          config,
          garde,
        );
      }) as unknown as Enregistreur;
      return enveloppe;
    },
  });
}
