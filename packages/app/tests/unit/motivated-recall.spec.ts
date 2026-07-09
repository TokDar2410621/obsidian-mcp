import { describe, it, expect, beforeAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { RagService } from '@/services/rag/rag-service';
import { MemoryStrengthStore } from '@/services/memory/memory-strength';
import type { VaultReader } from '@/services/rag/vault-reader';
import type { EmbeddingProvider } from '@/services/rag/embeddings';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

// Count-vector embedder (same spirit as rag.spec.ts): cosine = word overlap.
const VOCAB = ['redis', 'stripe', 'django'];
class FakeEmbedder implements EmbeddingProvider {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => {
      const v = new Float32Array(VOCAB.length);
      const lower = t.toLowerCase();
      VOCAB.forEach((w, i) => {
        v[i] = (lower.match(new RegExp(w, 'g')) ?? []).length;
      });
      if (v.every(x => x === 0)) v[0] = 1e-9;
      return v;
    });
  }
}

function makeReader(files: Record<string, string>): VaultReader {
  return {
    listMarkdownFiles: async () => Object.keys(files),
    readFile: async (f: string) => files[f],
  } as VaultReader;
}

function makeRag(files: Record<string, string>): RagService {
  return new RagService({
    reader: makeReader(files),
    embedder: new FakeEmbedder(),
    generator: null,
    indexFile: '/unused',
    persist: false,
    hybrid: false, // pure dense: deterministic base order for the test
  });
}

// Two chunks equally relevant to the query (tie on cosine), plus filler
// chunks so the pool is realistic (in prod the pool is 24: the positional
// base signal is fine-grained, and motivation can break ties).
const TIE_FILES: Record<string, string> = {
  'a.md': 'stripe stripe',
  'b.md': 'redis redis',
};
for (let i = 0; i < 10; i++) TIE_FILES[`filler-${i}.md`] = 'django';

describe('motivated recall (salience motivationnelle)', () => {
  it('the motivation vector breaks the tie toward the active priority', async () => {
    const rag = makeRag(TIE_FILES);
    rag.setMotivationProvider(async () => 'redis'); // Darius's priority talks redis
    const res = await rag.searchCerveau({ query: 'stripe redis' });
    expect(res.success).toBe(true);
    const results = (res.data as any).results;
    expect(results[0].path).toBe('b.md');
  });

  it('flipping the motivation flips the winner', async () => {
    const rag = makeRag(TIE_FILES);
    rag.setMotivationProvider(async () => 'stripe');
    const res = await rag.searchCerveau({ query: 'stripe redis' });
    expect((res.data as any).results[0].path).toBe('a.md');
  });

  it('a strong memory trace promotes its file (forgetting shapes recall)', async () => {
    const rag = makeRag(TIE_FILES);
    rag.setStrengthProvider(file => (file === 'a.md' ? 2 : 0));
    const res = await rag.searchCerveau({ query: 'stripe redis' });
    expect((res.data as any).results[0].path).toBe('a.md');
  });

  it('without motivation or strength, behaviour is unchanged (plat)', async () => {
    const rag = makeRag({ 'a.md': 'stripe', 'b.md': 'redis' });
    const res = await rag.searchCerveau({ query: 'stripe' });
    expect((res.data as any).results[0].path).toBe('a.md');
  });

  it('search reinforces the traces of what surfaced (recall on search)', async () => {
    const rag = makeRag({ 'a.md': 'stripe' });
    const recalled: string[][] = [];
    rag.setRecallListener(files => recalled.push(files));
    await rag.searchCerveau({ query: 'stripe' });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toContain('a.md');
  });
});

describe('memory strength: diminishing boost (plage dynamique restauree)', () => {
  it('no longer saturates at the cap after a few recalls', () => {
    const store = new MemoryStrengthStore(path.join(os.tmpdir(), `mem-${Date.now()}.json`));
    for (let i = 0; i < 5; i++) store.recordRecall(['a.md']);
    const s = store.strengthOf('a.md');
    expect(s).toBeGreaterThan(1.5); // it does grow
    expect(s).toBeLessThan(1.95); // but the old flat +0.5 would already be pinned at 2
  });

  it('more recalls still means more strength (discrimination)', () => {
    const store = new MemoryStrengthStore(path.join(os.tmpdir(), `mem2-${Date.now()}.json`));
    store.recordRecall(['often.md']);
    store.recordRecall(['often.md']);
    store.recordRecall(['often.md']);
    store.recordRecall(['rare.md']);
    expect(store.strengthOf('often.md')).toBeGreaterThan(store.strengthOf('rare.md'));
  });
});
