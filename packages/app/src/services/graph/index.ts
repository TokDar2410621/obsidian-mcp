import path from 'path';
import type { RagService } from '@/services/rag/rag-service';
import { GraphService } from '@/services/graph/graph-service';
import { LlmGraph } from '@/services/graph/graph-llm';
import { SettingsBackedCompleter, hasChatProvider } from '@/services/llm/settings-completer';
import { getSettingsStore } from '@/services/settings/settings-store';

export { GraphService } from '@/services/graph/graph-service';
export * from '@/services/graph/types';

/**
 * Build the GraphRAG service, or `null` when no LLM provider is configured.
 * Extraction + synthesis go through the runtime settings-backed completer.
 *
 * - `RAG_INDEX_DIR` — the persisted graph lives next to the RAG index.
 */
export function createGraphService(rag: RagService): GraphService | null {
  if (!hasChatProvider()) return null;

  const llm = new LlmGraph(new SettingsBackedCompleter(getSettingsStore()));
  const indexDir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');
  return new GraphService({ rag, llm, graphFile: path.join(indexDir, 'cerveau-graph.json') });
}
