import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as toolDefs from '@/mcp/tool-definitions';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { SynapsesService } from '@/services/synapses';

/**
 * Registers the Synapses tools (the "thinking" layer). Imported ONLY from the
 * local stdio/http entrypoints — never from `server/lambda/` or the shared
 * `tool-registrations.ts` — so the Anthropic SDK + node-cron stay out of the
 * bundled Lambda build. All read-only (propose-only: nothing mutates the vault).
 */
export function registerSynapsesTools(server: McpServer, synapses: SynapsesService): void {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false, // LLM-backed, non-deterministic
    openWorldHint: true, // calls embedding + LLM APIs
  };

  server.registerTool(
    'suggest-links',
    {
      title: 'Suggest Links',
      description:
        'Find pairs of notes that are semantically related but not yet linked by a wikilink, prioritising cross-project ("invisible") connections. Returns suggested [[links]] with a one-line rationale. Read-only — proposes, never edits.',
      inputSchema: toolDefs.SuggestLinksSchema.inputSchema,
      outputSchema: toolDefs.SuggestLinksSchema.outputSchema,
      annotations: readOnly,
    },
    async args => formatToolResult(await synapses.suggestLinks(args)),
  );

  server.registerTool(
    'audit-coherence',
    {
      title: 'Audit Coherence',
      description:
        'Detect coherence problems across the vault: decisions/specs that contradict each other, notes that make others stale, and near-duplicate notes to merge. Read-only.',
      inputSchema: toolDefs.AuditCoherenceSchema.inputSchema,
      outputSchema: toolDefs.AuditCoherenceSchema.outputSchema,
      annotations: readOnly,
    },
    async args => formatToolResult(await synapses.auditCoherence(args)),
  );

  server.registerTool(
    'find-themes',
    {
      title: 'Find Themes',
      description:
        'Cluster the vault by meaning and name the emergent themes that cut across projects, flagging clusters forming mostly from recent captures/daily notes ("emerging"). Read-only.',
      inputSchema: toolDefs.FindThemesSchema.inputSchema,
      outputSchema: toolDefs.FindThemesSchema.outputSchema,
      annotations: readOnly,
    },
    async args => formatToolResult(await synapses.findThemes(args)),
  );

  server.registerTool(
    'cerveau-digest',
    {
      title: 'Cerveau Digest',
      description:
        'Run all three Synapses analyses (missing links, coherence, emergent themes) and return a single Markdown digest of the vault. Read-only — does not write the digest note (the weekly cron does that).',
      inputSchema: toolDefs.CerveauDigestSchema.inputSchema,
      outputSchema: toolDefs.CerveauDigestSchema.outputSchema,
      annotations: readOnly,
    },
    async () => formatToolResult(await synapses.digest()),
  );
}
