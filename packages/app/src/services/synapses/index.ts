import type { RagService } from '@/services/rag/rag-service';
import { ProviderCompleter } from '@/services/synapses/completer';
import { SynapsesService } from '@/services/synapses/synapses-service';
import { createChatProvider, defaultLlmModel } from '@/services/llm';

export { SynapsesService } from '@/services/synapses/synapses-service';
export * from '@/services/synapses/types';

/**
 * Build the Synapses service from environment, or `null` when it can't run.
 * Requires the RAG layer (embeddings) AND an LLM provider (see
 * {@link createChatProvider}: `LLM_BASE_URL`+`LLM_API_KEY` or `ANTHROPIC_API_KEY`).
 *
 * - `SYNAPSES_MODEL` — overrides `RAG_GENERATION_MODEL` for Synapses.
 */
export function createSynapsesService(rag: RagService): SynapsesService | null {
  const provider = createChatProvider();
  if (!provider) return null;

  const model =
    process.env.SYNAPSES_MODEL ||
    process.env.RAG_GENERATION_MODEL ||
    defaultLlmModel('claude-opus-4-8');
  return new SynapsesService({ rag, llm: new ProviderCompleter(provider, model) });
}
