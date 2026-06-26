import type { RagService } from '@/services/rag/rag-service';
import { SynapsesService } from '@/services/synapses/synapses-service';
import { SettingsBackedCompleter, hasChatProvider } from '@/services/llm/settings-completer';
import { getSettingsStore } from '@/services/settings/settings-store';

export { SynapsesService } from '@/services/synapses/synapses-service';
export * from '@/services/synapses/types';

/**
 * Build the Synapses service, or `null` when no LLM provider is configured.
 * The completer resolves provider+model at runtime (web Settings page).
 */
export function createSynapsesService(rag: RagService): SynapsesService | null {
  if (!hasChatProvider()) return null;
  return new SynapsesService({ rag, llm: new SettingsBackedCompleter(getSettingsStore()) });
}
