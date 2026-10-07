import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { SkillsService } from '@/services/skills/skills-service';

/**
 * find-skill et read-skill (spec du 2026-10-07, §2.3) : l'assistant cherche
 * le bon skill par le sens, puis charge son contenu complet dans sa
 * conversation. Lecture seule, sur l'instance perso comme sur Dan.
 */
export function registerSkillsTools(server: McpServer, skills: SkillsService): void {
  server.registerTool(
    'find-skill',
    {
      title: 'Find Skill',
      description:
        'Cherche par le sens, dans le catalogue de skills du cerveau (09-skills/), le skill qui convient a une tache. Les skills sont rediges en ANGLAIS : formule la requete en anglais, meme si la conversation est en francais (ex. « debug python », « write landing page copy », « how much should I charge »). Rend nom, description, collection et score, sans le contenu : charge ensuite le skill choisi avec read-skill.',
      inputSchema: {
        query: z.string().min(1).describe('La tache ou le besoin, en langage naturel et EN ANGLAIS'),
        limit: z
          .number()
          .optional()
          .describe('Nombre de skills a rendre (defaut 5, max 20)'),
      },
      outputSchema: {
        skills: z.array(
          z.object({
            nom: z.string(),
            description: z.string(),
            collection: z.string(),
            score: z.number(),
          }),
        ),
        total: z.number(),
        catalogue: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // appelle l'API d'embeddings
      },
    },
    async args => formatToolResult(await skills.trouver(args)),
  );

  server.registerTool(
    'read-skill',
    {
      title: 'Read Skill',
      description:
        'Rend le contenu complet d\'un skill du catalogue (09-skills/), a partir du nom exact rendu par find-skill. Liste aussi ses fichiers de reference, lisibles avec read-note. Nom inconnu : erreur avec les noms proches.',
      inputSchema: {
        name: z.string().min(1).describe('Nom exact du skill, tel que rendu par find-skill'),
      },
      outputSchema: {
        nom: z.string(),
        collection: z.string(),
        description: z.string(),
        chemin: z.string(),
        contenu: z.string(),
        references: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async args => formatToolResult(await skills.lire(args)),
  );
}
