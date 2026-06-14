import path from 'path';
import type { RagService } from '@/services/rag/rag-service';
import { GraphService } from '@/services/graph/graph-service';
import { AnthropicGraphLlm } from '@/services/graph/graph-llm';

export { GraphService } from '@/services/graph/graph-service';
export * from '@/services/graph/types';

/**
 * Build the GraphRAG service from env, or `null` when it can't run. Requires the
 * RAG layer (note text) AND `ANTHROPIC_API_KEY` (extraction + synthesis).
 *
 * - `GRAPH_EXTRACT_MODEL` — per-note extraction model (default `claude-haiku-4-5`).
 * - `GRAPH_MODEL`         — multi-hop synthesis model (default `RAG_GENERATION_MODEL`).
 * - `RAG_INDEX_DIR`       — the persisted graph lives next to the RAG index.
 */
export function createGraphService(rag: RagService): GraphService | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  const llm = new AnthropicGraphLlm(
    anthropicKey,
    process.env.GRAPH_EXTRACT_MODEL || 'claude-haiku-4-5',
    process.env.GRAPH_MODEL || process.env.RAG_GENERATION_MODEL || 'claude-opus-4-8',
  );
  const indexDir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');
  return new GraphService({ rag, llm, graphFile: path.join(indexDir, 'cerveau-graph.json') });
}
