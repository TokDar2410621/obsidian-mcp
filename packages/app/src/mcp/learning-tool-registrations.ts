import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as toolDefs from '@/mcp/tool-definitions';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { LearningService, LearningsStore } from '@/services/learning';

/**
 * Registers the learning-loop tools. Imported ONLY from http/stdio (never
 * server/lambda), so the Anthropic SDK stays out of the Lambda bundle.
 * `remember-preference` writes the feedback memory; the other two are read-only.
 */
export function registerLearningTools(
  server: McpServer,
  learning: LearningService,
  store: LearningsStore,
): void {
  server.registerTool(
    'remember-preference',
    {
      title: 'Remember Preference',
      description:
        "Save a preference or correction to the vault's feedback memory (_learnings.md). The cerveau reads these before answering (ask-cerveau) — this is how it learns your preferences without retraining.",
      inputSchema: toolDefs.RememberPreferenceSchema.inputSchema,
      outputSchema: toolDefs.RememberPreferenceSchema.outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false, // additive append
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async args => {
      const ts = new Date().toISOString();
      try {
        const result = await store.addPreference(args.preference);
        return formatToolResult({ success: true, data: result, metadata: { timestamp: ts } });
      } catch (error: any) {
        return formatToolResult({
          success: false,
          error: error?.message ?? String(error),
          metadata: { timestamp: ts },
        });
      }
    },
  );

  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  server.registerTool(
    'consolidate-cerveau',
    {
      title: 'Consolidate Cerveau',
      description:
        'Review raw / daily captures and propose distilled knowledge notes to create (promote) or merges — the "reflection" step that turns scattered captures into structured knowledge. Propose-only.',
      inputSchema: toolDefs.ConsolidateCerveauSchema.inputSchema,
      outputSchema: toolDefs.ConsolidateCerveauSchema.outputSchema,
      annotations: readOnly,
    },
    async () => formatToolResult(await learning.consolidate()),
  );

  server.registerTool(
    'find-gaps',
    {
      title: 'Find Gaps',
      description:
        'Surface gaps in the vault: recurring topics with no dedicated note, areas that look stale, and obvious holes. Propose-only.',
      inputSchema: toolDefs.FindGapsSchema.inputSchema,
      outputSchema: toolDefs.FindGapsSchema.outputSchema,
      annotations: readOnly,
    },
    async () => formatToolResult(await learning.findGaps()),
  );
}
