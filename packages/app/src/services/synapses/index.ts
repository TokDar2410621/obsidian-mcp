import type { RagService } from '@/services/rag/rag-service';
import { AnthropicCompleter } from '@/services/synapses/completer';
import { SynapsesService } from '@/services/synapses/synapses-service';

export { SynapsesService } from '@/services/synapses/synapses-service';
export * from '@/services/synapses/types';

/**
 * Build the Synapses service from environment, or `null` when it can't run.
 * Requires the RAG layer (embeddings) AND `ANTHROPIC_API_KEY` — every Synapses
 * capability makes an LLM call. Absent key ⇒ no Synapses tools registered.
 *
 * - `SYNAPSES_MODEL` — overrides `RAG_GENERATION_MODEL` for Synapses (default `claude-opus-4-8`).
 */
export function createSynapsesService(rag: RagService): SynapsesService | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  const model = process.env.SYNAPSES_MODEL || process.env.RAG_GENERATION_MODEL || 'claude-opus-4-8';
  return new SynapsesService({ rag, llm: new AnthropicCompleter(anthropicKey, model) });
}
