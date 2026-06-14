import type { VaultManager } from '@/services/vault-manager';
import type { RagService } from '@/services/rag/rag-service';
import { AnthropicCompleter } from '@/services/synapses/completer';
import { LearningService } from '@/services/learning/learning-service';
import { LearningsStore } from '@/services/learning/learnings-store';

export { LearningService } from '@/services/learning/learning-service';
export { LearningsStore, LEARNINGS_FILE } from '@/services/learning/learnings-store';

export interface LearningBundle {
  service: LearningService;
  store: LearningsStore;
}

/**
 * Build the learning loops, or `null` when `ANTHROPIC_API_KEY` is absent.
 * - `service` — consolidation + gap analyses (LLM).
 * - `store`   — the `_learnings.md` feedback memory.
 *
 * `LEARNING_MODEL` overrides `RAG_GENERATION_MODEL` for the analyses.
 */
export function createLearning(rag: RagService, vault: VaultManager): LearningBundle | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;
  const model = process.env.LEARNING_MODEL || process.env.RAG_GENERATION_MODEL || 'claude-opus-4-8';
  return {
    service: new LearningService({ rag, llm: new AnthropicCompleter(anthropicKey, model) }),
    store: new LearningsStore(vault),
  };
}
