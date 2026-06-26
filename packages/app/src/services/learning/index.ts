import type { VaultManager } from '@/services/vault-manager';
import type { RagService } from '@/services/rag/rag-service';
import { LearningService } from '@/services/learning/learning-service';
import { LearningsStore } from '@/services/learning/learnings-store';
import { SettingsBackedCompleter, hasChatProvider } from '@/services/llm/settings-completer';
import { getSettingsStore } from '@/services/settings/settings-store';

export { LearningService } from '@/services/learning/learning-service';
export { LearningsStore, LEARNINGS_FILE } from '@/services/learning/learnings-store';

export interface LearningBundle {
  service: LearningService;
  store: LearningsStore;
}

/**
 * Build the learning loops, or `null` when no LLM provider is configured.
 * - `service` — consolidation + gap analyses (LLM, runtime-selected model).
 * - `store`   — the `_learnings.md` feedback memory.
 */
export function createLearning(rag: RagService, vault: VaultManager): LearningBundle | null {
  if (!hasChatProvider()) return null;
  return {
    service: new LearningService({ rag, llm: new SettingsBackedCompleter(getSettingsStore()) }),
    store: new LearningsStore(vault),
  };
}
