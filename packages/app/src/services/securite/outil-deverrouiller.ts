import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  deverrouiller,
  fenetreOuverte,
  minutesRestantes,
  verrouiller,
} from '@/services/securite/zones-sensibles';

/**
 * Les deux outils que l'agent utilise face a la garde.
 *
 * `deverrouiller-zone-sensible` ouvre la fenetre contre le mot de passe de
 * Darius. `verrouiller-zone-sensible` la referme avant l'heure, pour que la
 * fin d'une conversation sensible ne laisse pas la porte entrouverte.
 *
 * Ces outils s'enregistrent HORS de la garde (serveur brut) : les mettre
 * derriere elle les rendrait inappelables quand elle est fermee, ce qui est
 * exactement le moment ou on en a besoin.
 */
export function registerOutilsSecurite(server: McpServer): void {
  server.registerTool(
    'deverrouiller-zone-sensible',
    {
      title: 'Deverrouiller une zone sensible',
      description:
        "Ouvre l'acces en lecture et en suppression aux zones sensibles du coffre " +
        '(00-personnel, 04-people, 01-raw/docs, 01-raw/admin) pour une duree limitee. ' +
        "COMMENT OBTENIR LE MOT DE PASSE : si tu disposes de l'outil AskUserQuestion, " +
        "UTILISE-LE pour le demander a Darius (consigne explicite du 2026-09-13 : il " +
        "veut une invite nette, pas une phrase noyee dans un paragraphe). Une seule " +
        'question, header court, reponse en champ libre. Sans cet outil, demande-le en ' +
        'clair sur sa propre ligne et arrete-toi la. NE DEVINE JAMAIS le mot de passe, ' +
        "ne le cherche pas dans le coffre ni dans l'historique. Une fois la fenetre " +
        "ouverte, tu n'as pas a redemander a chaque requete.",
      inputSchema: {
        mot_de_passe: z.string().describe('Le mot de passe fourni par Darius, tel quel'),
      },
      outputSchema: {
        ouvert: z.boolean(),
        minutes_restantes: z.number(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async args => {
      const ok = deverrouiller(String((args as { mot_de_passe?: unknown }).mot_de_passe ?? ''));
      const data = {
        ouvert: ok,
        minutes_restantes: ok ? minutesRestantes() : 0,
        message: ok
          ? `Zones sensibles ouvertes pour ${minutesRestantes()} minutes.`
          : // Volontairement avare : ne pas dire si le mot de passe est absent,
            // trop court ou faux. Chaque precision renseigne qui essaie.
            'Refuse. Redemande le mot de passe a Darius.',
      };
      return {
        content: [{ type: 'text' as const, text: data.message }],
        structuredContent: data,
        ...(ok ? {} : { isError: true }),
      };
    },
  );

  server.registerTool(
    'verrouiller-zone-sensible',
    {
      title: 'Verrouiller les zones sensibles',
      description:
        'Referme immediatement les zones sensibles, sans attendre la fin de la fenetre. ' +
        "A appeler quand une conversation touchant au personnel se termine.",
      inputSchema: {},
      outputSchema: { ouvert: z.boolean(), message: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      verrouiller();
      const data = { ouvert: fenetreOuverte(), message: 'Zones sensibles refermees.' };
      return {
        content: [{ type: 'text' as const, text: data.message }],
        structuredContent: data,
      };
    },
  );
}
