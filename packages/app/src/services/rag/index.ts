import path from 'path';
import type { VaultManager } from '@/services/vault-manager';
import { RagService } from '@/services/rag/rag-service';
import { OpenAiEmbeddingProvider } from '@/services/rag/embeddings';
import { RagAnswerGenerator } from '@/services/rag/generator';
import { GitVaultReader } from '@/services/rag/vault-reader';
import { LlmReranker } from '@/services/rag/reranker';
import { createChatProvider, defaultLlmModel } from '@/services/llm';

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
 * - LLM (for ask-cerveau answer generation) — provided by `createChatProvider()`:
 *     `LLM_BASE_URL` + `LLM_API_KEY` (any OpenAI-compatible endpoint, e.g.
 *     Hugging Face) OR `ANTHROPIC_API_KEY`. Without one, search-cerveau still works.
 * - `RAG_EMBEDDING_MODEL`   — default `text-embedding-3-small`.
 * - `RAG_GENERATION_MODEL`  — answer model (default `LLM_MODEL` or `claude-opus-4-8`).
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

  const provider = createChatProvider();
  const generator = provider
    ? new RagAnswerGenerator(provider, process.env.RAG_GENERATION_MODEL || defaultLlmModel('claude-opus-4-8'))
    : null;

  const indexDir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');

  // Advanced retrieval: hybrid (BM25 + dense via RRF) is on by default; an
  // optional LLM reranker refines the fused shortlist — enabled when an LLM
  // provider is present unless RAG_RERANK=off.
  const hybrid = (process.env.RAG_HYBRID || 'on').toLowerCase() !== 'off';
  const reranker =
    provider && (process.env.RAG_RERANK || 'on').toLowerCase() !== 'off'
      ? new LlmReranker(provider, process.env.RAG_RERANK_MODEL || defaultLlmModel('claude-haiku-4-5'))
      : null;

  return new RagService({
    reader: new GitVaultReader(vault),
    embedder,
    generator,
    indexFile: path.join(indexDir, 'cerveau-index.json'),
    persist: true,
    hybrid,
    reranker,
  });
}
