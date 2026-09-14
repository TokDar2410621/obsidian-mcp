import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { garder } from '@/services/securite/zones-sensibles';

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
          return (handler as (a: unknown, e: unknown) => unknown)(args, extra);
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
