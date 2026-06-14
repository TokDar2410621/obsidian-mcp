import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as toolDefs from '@/mcp/tool-definitions';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { GraphService } from '@/services/graph';

/**
 * Registers the GraphRAG tools. Imported ONLY from the local stdio/http
 * entrypoints — never from `server/lambda/` — so the Anthropic SDK stays out of
 * the bundled Lambda build. Both read-only.
 */
export function registerGraphTools(server: McpServer, graph: GraphService): void {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  server.registerTool(
    'graph-cerveau',
    {
      title: 'Graph Cerveau (multi-hop)',
      description:
        "Answer a question by reasoning over the vault's knowledge graph (entities + relations). Expands around the question's entities for multi-hop connections, then synthesizes a cited answer. Complements ask-cerveau (passage-based) with relationship reasoning.",
      inputSchema: toolDefs.GraphCerveauSchema.inputSchema,
      outputSchema: toolDefs.GraphCerveauSchema.outputSchema,
      annotations: readOnly,
    },
    async args => formatToolResult(await graph.graphAsk(args)),
  );

  server.registerTool(
    'graph-overview',
    {
      title: 'Graph Overview',
      description:
        'Structural view of the vault knowledge graph: size, communities (clusters of connected entities), and the most-connected hub entities. No LLM call.',
      inputSchema: toolDefs.GraphOverviewSchema.inputSchema,
      outputSchema: toolDefs.GraphOverviewSchema.outputSchema,
      annotations: readOnly,
    },
    async args => formatToolResult(await graph.graphOverview(args)),
  );
}
