import path from 'path';
import type { VaultManager } from '@/services/vault-manager';
import { RagService } from '@/services/rag/rag-service';
import { OpenAiEmbeddingProvider } from '@/services/rag/embeddings';
import { RagAnswerGenerator } from '@/services/rag/generator';
import { GitVaultReader } from '@/services/rag/vault-reader';
import { LlmReranker } from '@/services/rag/reranker';
import { SettingsBackedCompleter, hasChatProvider } from '@/services/llm/settings-completer';
import { getSettingsStore } from '@/services/settings/settings-store';

export { RagService } from '@/services/rag/rag-service';
export type { RagServiceOptions } from '@/services/rag/rag-service';
export * from '@/services/rag/types';

/**
 * Build the RAG service from environment, or `null` when RAG isn't configured
 * (no `OPENAI_API_KEY`). The answer generator + reranker run through the
 * settings-backed completer, so the active model/provider is chosen at runtime
 * (web Settings page) rather than fixed at boot. `RAG_RERANK`/`RAG_HYBRID` seed
 * the defaults; the live values come from the {@link SettingsStore}.
 *
 * - `OPENAI_API_KEY`       — required (embeddings).
 * - LLM provider           — `hasChatProvider()` (HF / OpenAI / Anthropic env).
 * - `RAG_INDEX_DIR`        — index + settings JSON (MUST be outside the vault clone).
 */
export function createRagService(vault: VaultManager): RagService | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  const embedder = new OpenAiEmbeddingProvider(
    openaiKey,
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small',
  );

  const settings = getSettingsStore();
  const completer = hasChatProvider() ? new SettingsBackedCompleter(settings) : null;
  const generator = completer ? new RagAnswerGenerator(completer) : null;
  const reranker = completer ? new LlmReranker(completer) : null;

  const indexDir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');

  return new RagService({
    reader: new GitVaultReader(vault),
    embedder,
    generator,
    indexFile: path.join(indexDir, 'cerveau-index.json'),
    persist: true,
    hybrid: settings.get().retrieval.hybrid,
    reranker,
    settings,
  });
}
