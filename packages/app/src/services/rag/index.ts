import path from 'path';
import type { VaultManager } from '@/services/vault-manager';
import { RagService } from '@/services/rag/rag-service';
import { OpenAiEmbeddingProvider } from '@/services/rag/embeddings';
import { AnthropicAnswerGenerator } from '@/services/rag/generator';
import { GitVaultReader } from '@/services/rag/vault-reader';

export { RagService } from '@/services/rag/rag-service';
export type { RagServiceOptions } from '@/services/rag/rag-service';
export * from '@/services/rag/types';

/**
 * Build the RAG service from environment configuration, or return `null` when
 * RAG is not configured (no `OPENAI_API_KEY`). Optional, lazy config — absent
 * keys simply leave the two cerveau tools unregistered, so existing deployments
 * are unaffected.
 *
 * - `OPENAI_API_KEY`        — required to enable RAG (embeddings).
 * - `ANTHROPIC_API_KEY`     — enables ask-cerveau (answer generation); without
 *                             it, search-cerveau still works.
 * - `RAG_EMBEDDING_MODEL`   — default `text-embedding-3-small`.
 * - `RAG_GENERATION_MODEL`  — default `claude-opus-4-8`.
 * - `RAG_INDEX_DIR`         — where the index JSON lives (MUST be outside the
 *                             vault clone, which git wipes on every sync).
 */
export function createRagService(vault: VaultManager): RagService | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  const embedder = new OpenAiEmbeddingProvider(
    openaiKey,
    process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small',
  );

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const generator = anthropicKey
    ? new AnthropicAnswerGenerator(
        anthropicKey,
        process.env.RAG_GENERATION_MODEL || 'claude-opus-4-8',
      )
    : null;

  const indexDir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');

  return new RagService({
    reader: new GitVaultReader(vault),
    embedder,
    generator,
    indexFile: path.join(indexDir, 'cerveau-index.json'),
    persist: true,
  });
}
