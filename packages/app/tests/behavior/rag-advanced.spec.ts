import { describe, expect, it } from 'vitest';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { RagService } from '@/services/rag/rag-service';
import { BM25Index, rrf, tokenize } from '@/services/rag/bm25';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import type { Reranker, RerankCandidate } from '@/services/rag/reranker';

const VOCAB = ['redis', 'stripe', 'django'];
function toVector(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map(w => (lower.match(new RegExp(w, 'g')) ?? []).length);
}
class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(toVector);
  }
}
function makeReader(vault: InMemoryVaultManager): VaultReader {
  return {
    listMarkdownFiles: () => vault.listFiles('', { recursive: true, fileTypes: ['md'] }),
    readFile: p => vault.readFile(p),
  };
}
/** Promotes any candidate whose text contains "PICKME" to the top. */
class FakeReranker implements Reranker {
  async rerank(_query: string, candidates: RerankCandidate[]): Promise<string[]> {
    const pick = candidates.filter(c => /pickme/i.test(c.text)).map(c => c.id);
    const rest = candidates.filter(c => !/pickme/i.test(c.text)).map(c => c.id);
    return [...pick, ...rest];
  }
}

describe('Advanced RAG — BM25 + RRF', () => {
  it('tokenizes (lowercase, accent-stripped)', () => {
    expect(tokenize('Réindexée DB0!')).toEqual(['reindexee', 'db0']);
  });

  it('BM25 scores only docs containing the query terms', () => {
    const idx = new BM25Index([
      'redis dual db pattern',
      'stripe connect webhooks',
      'django orm migrations',
    ]);
    const scores = idx.score('redis pattern', [0, 1, 2]);
    expect(scores.get(0)).toBeGreaterThan(0);
    expect(scores.has(1)).toBe(false);
    expect(scores.has(2)).toBe(false);
  });

  it('rrf rewards items ranked high across lists', () => {
    expect(
      rrf([
        [0, 1, 2],
        [0, 2, 1],
      ])[0],
    ).toBe(0);
  });
});

describe('Advanced RAG — hybrid + rerank integration', () => {
  it('applies the reranker order over the fused shortlist', async () => {
    const vault = new InMemoryVaultManager({
      'a.md': '# A\n\nredis redis redis',
      'b.md': '# B\n\nredis PICKME',
    });
    const rag = new RagService({
      reader: makeReader(vault),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile: '/unused',
      persist: false,
      reranker: new FakeReranker(),
    });
    const res = await rag.searchCerveau({ query: 'redis' });
    expect(res.success).toBe(true);
    expect(res.data.results[0].path).toBe('b.md'); // reranker promoted PICKME
  });

  it('hybrid retrieval still surfaces the dense-relevant note (no reranker)', async () => {
    const vault = new InMemoryVaultManager({
      '02-knowledge/redis/r.md': '# Redis\n\nredis dual db',
      '02-knowledge/stripe/s.md': '# Stripe\n\nstripe connect',
    });
    const rag = new RagService({
      reader: makeReader(vault),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile: '/unused',
      persist: false,
    });
    const res = await rag.searchCerveau({ query: 'redis db' });
    expect(res.data.results[0].path).toBe('02-knowledge/redis/r.md');
  });
});
