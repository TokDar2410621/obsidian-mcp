import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as toolDefs from '@/mcp/tool-definitions';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { RagService } from '@/services/rag';

/**
 * Registers the two semantic RAG tools. Imported ONLY from the local
 * stdio/http entrypoints (never from `server/lambda/` or the shared
 * `tool-registrations.ts`), so the RAG service + Anthropic SDK stay out of the
 * bundled Lambda build.
 *
 * `ask-cerveau` is registered only when the service can generate answers
 * (ANTHROPIC_API_KEY present); otherwise just `search-cerveau` is exposed.
 */
export function registerRagTools(server: McpServer, rag: RagService): void {
  server.registerTool(
    'search-cerveau',
    {
      title: 'Search Cerveau (semantic)',
      description:
        'Semantic search across the vault — finds notes by meaning (embeddings), complementing the keyword search-vault tool. Returns ranked note chunks with wikilinks and excerpts.',
      inputSchema: toolDefs.SearchCerveauSchema.inputSchema,
      outputSchema: toolDefs.SearchCerveauSchema.outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // calls the embedding API
      },
    },
    async args => {
      const result = await rag.searchCerveau(args);
      return formatToolResult(result);
    },
  );

  if (rag.canGenerate) {
    server.registerTool(
      'ask-cerveau',
      {
        title: 'Ask Cerveau (RAG)',
        description:
          'Answer a question using the knowledge in the vault. Retrieves the most relevant notes semantically and has Claude write a grounded answer with [[wikilink]] citations to the source notes.',
        inputSchema: toolDefs.AskCerveauSchema.inputSchema,
        outputSchema: toolDefs.AskCerveauSchema.outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false, // generation is non-deterministic
          openWorldHint: true, // calls embedding + LLM APIs
        },
      },
      async args => {
        const result = await rag.askCerveau(args);
        return formatToolResult(result);
      },
    );
  }
}
