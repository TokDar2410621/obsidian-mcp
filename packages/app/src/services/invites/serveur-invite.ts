import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appelant } from '@/services/securite/appelant';
import { cheminsDe } from '@/services/securite/garde-mcp';
import { jourMontreal, type InviteStore, type ResultatAudit } from '@/services/invites/invite-store';
import { logger } from '@/utils/logger';

/**
 * Les seuls outils que Dan expose a un ami (spec du 2026-10-07, §1.4).
 *
 * Liste BLANCHE : un outil ajoute demain au serveur reste invisible des amis
 * tant que quelqu'un ne l'ajoute pas ici, en connaissance de cause. Une liste
 * noire aurait ouvert par defaut tout ce qu'on oublie d'y inscrire.
 */
export const OUTILS_DAN: ReadonlySet<string> = new Set([
  'read-note',
  'read-notes',
  'list-files-in-vault',
  'list-files-in-dir',
  'search-vault',
  'search-cerveau',
  'ask-cerveau',
  'graph-cerveau',
  'graph-overview',
  'find-themes',
  'suggest-links',
  'cerveau-digest',
  'find-skill',
  'read-skill',
]);

/** Outils qui appellent un LLM ou les embeddings : ce sont eux que le quota compte. */
export const OUTILS_COUTEUX: ReadonlySet<string> = new Set([
  'search-cerveau',
  'ask-cerveau',
  'graph-cerveau',
  'graph-overview',
  'find-themes',
  'suggest-links',
  'cerveau-digest',
  'find-skill',
]);

export interface OptionsServeurInvite {
  invites: InviteStore;
  /** Appels couteux permis par ami et par jour (America/Montreal). */
  quotaJour: number;
  /** Horloge injectable (tests). */
  maintenant?: () => Date;
}

type Resultat = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function erreur(texte: string): Resultat {
  return { content: [{ type: 'text', text: texte }], isError: true };
}

export function messageQuota(quota: number): string {
  return (
    `Quota du jour atteint : ${quota} recherches par jour. Il se remet à zéro à minuit, ` +
    `heure de Montréal. Les lectures de notes (read-note, read-notes, list-files-in-vault, ` +
    `list-files-in-dir, search-vault, read-skill) restent disponibles.`
  );
}

/**
 * search-vault compile `path_filter` en RegExp : `(.+)+\u0000` gele la boucle
 * d'evenements pour tous les amis (revue du 2026-10-07, ReDoS). Chez Dan, le
 * filtre devient un texte litteral, borne a 200 caracteres.
 */
export function assainirArguments(nom: string, args: unknown): unknown {
  if (nom !== 'search-vault' || !args || typeof args !== 'object') return args;
  const a = args as Record<string, unknown>;
  if (typeof a.path_filter !== 'string') return args;
  const litteral = a.path_filter.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { ...a, path_filter: litteral };
}

/** Ce que l'audit retient d'un appel : des chemins ou un nom de skill, jamais le reste. */
function cibles(nom: string, args: unknown): string[] {
  const chemins = cheminsDe(args);
  if (nom === 'read-skill' && args && typeof args === 'object') {
    const n = (args as Record<string, unknown>).name;
    if (typeof n === 'string' && n) chemins.push(`skill:${n}`);
  }
  return chemins.slice(0, 20);
}

type Enregistreur = McpServer['registerTool'];

/**
 * Enveloppe le serveur MCP de Dan : liste blanche, description « Dan », quota
 * par ami, audit. Meme technique que serveurGarde (un Proxy sur registerTool)
 * pour que chaque outil enregistre plus tard passe par la meme porte.
 */
export function serveurInvite(server: McpServer, options: OptionsServeurInvite): McpServer {
  const maintenant = options.maintenant ?? (() => new Date());

  const auditer = async (
    invite: { id: string; nom: string },
    outil: string,
    chemins: string[],
    resultat: ResultatAudit,
  ): Promise<void> => {
    const entree = {
      horodatage: maintenant().getTime(),
      inviteId: invite.id,
      nom: invite.nom,
      outil,
      chemins,
      resultat,
    };
    logger.info('Dan : appel', { audit: entree });
    try {
      await options.invites.journaliser(entree);
    } catch (error) {
      // L'audit ne doit jamais casser un appel : il manque une ligne, on le dit.
      logger.error('Dan : audit non enregistre', { error: String(error) });
    }
  };

  return new Proxy(server, {
    get(cible, prop, recepteur) {
      if (prop !== 'registerTool') return Reflect.get(cible, prop, recepteur);
      const original = Reflect.get(cible, prop, recepteur) as Enregistreur;
      const enveloppe = ((nom: string, config: Record<string, unknown>, handler: unknown) => {
        if (!OUTILS_DAN.has(nom)) {
          logger.debug('Dan : outil non expose', { outil: nom });
          return undefined;
        }
        const description =
          typeof config?.description === 'string' ? config.description : '';
        const configDan = {
          ...config,
          description: `Dan, l'IA de Darius (lecture seule). ${description}`.trim(),
        };
        const garde = async (argsBruts: unknown, extra: unknown): Promise<unknown> => {
          const args = assainirArguments(nom, argsBruts);
          const invite = appelant().invite;
          if (!invite) return erreur('Appel refusé : aucun ami authentifié.');
          const chemins = cibles(nom, args);

          if (OUTILS_COUTEUX.has(nom)) {
            const compte = await options.invites.incrementerQuota(
              invite.id,
              jourMontreal(maintenant()),
            );
            if (compte > options.quotaJour) {
              await auditer(invite, nom, chemins, 'quota');
              return erreur(messageQuota(options.quotaJour));
            }
          }

          let resultat: Resultat;
          try {
            resultat = (await (handler as (a: unknown, e: unknown) => Promise<Resultat>)(
              args,
              extra,
            )) as Resultat;
          } catch (error) {
            logger.error('Dan : outil en echec', { outil: nom, error: String(error) });
            await auditer(invite, nom, chemins, 'erreur');
            return erreur("Dan n'a pas pu répondre à cette demande.");
          }
          await auditer(invite, nom, chemins, resultat?.isError ? 'erreur' : 'ok');
          return resultat;
        };
        return (original as unknown as (...a: unknown[]) => unknown).call(cible, nom, configDan, garde);
      }) as unknown as Enregistreur;
      return enveloppe;
    },
  });
}
