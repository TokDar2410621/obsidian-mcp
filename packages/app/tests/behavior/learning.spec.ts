import { describe, expect, it } from 'vitest';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { RagService } from '@/services/rag/rag-service';
import { LearningsStore } from '@/services/learning/learnings-store';
import { LearningService } from '@/services/learning/learning-service';
import type {
  AnswerGenerator,
  EmbeddingProvider,
  GenResult,
  VaultReader,
} from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';

const VOCAB = ['redis', 'stripe'];
class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => VOCAB.map(w => (t.toLowerCase().match(new RegExp(w, 'g')) ?? []).length));
  }
}
function makeReader(vault: InMemoryVaultManager): VaultReader {
  return {
    listMarkdownFiles: () => vault.listFiles('', { recursive: true, fileTypes: ['md'] }),
    readFile: p => vault.readFile(p),
  };
}
class FakeCompleter implements LlmCompleter {
  readonly model = 'fake';
  async complete(system: string): Promise<string> {
    if (system.includes('promote')) {
      return JSON.stringify([
        {
          action: 'promote',
          title: 'Redis patterns',
          summary: 'Regroupe les captures Redis.',
          sources: ['01-raw/r.md'],
        },
      ]);
    }
    if (system.includes('LACUNES')) {
      return JSON.stringify([
        {
          topic: 'Tests E2E',
          reason: 'souvent mentionné, pas de note',
          suggestion: 'créer une note',
        },
      ]);
    }
    return '[]';
  }
}
async function buildRag(
  files: Record<string, string>,
  generator: AnswerGenerator | null = null,
): Promise<RagService> {
  const rag = new RagService({
    reader: makeReader(new InMemoryVaultManager(files)),
    embedder: new FakeEmbedder(),
    generator,
    indexFile: '/unused',
    persist: false,
  });
  await rag.ensureReady();
  return rag;
}

describe('Learning — feedback memory (_learnings.md)', () => {
  it('creates, appends, and reads back preferences', async () => {
    const store = new LearningsStore(new InMemoryVaultManager({}));
    expect(await store.getLearnings()).toBe('');

    const r1 = await store.addPreference('Toujours répondre court');
    expect(r1.path).toBe('_learnings.md');
    expect(r1.total).toBe(1);

    const r2 = await store.addPreference('Citer les sources');
    expect(r2.total).toBe(2);

    const body = await store.getLearnings();
    expect(body).toContain('Toujours répondre court');
    expect(body).toContain('Citer les sources');
    expect(body.startsWith('---')).toBe(false); // frontmatter stripped
  });
});

describe('Learning — consolidation & gaps', () => {
  const VAULT = {
    '01-raw/r.md': '# R\n\nredis redis idée en vrac',
    '03-daily/2026-06-13.md': '# Jour\n\nréflexion stripe',
    '02-knowledge/x.md': '# X\n\nconnaissance',
  };

  it('proposes promotions from raw/daily captures', async () => {
    const svc = new LearningService({ rag: await buildRag(VAULT), llm: new FakeCompleter() });
    const res = await svc.consolidate();
    expect(res.success).toBe(true);
    expect(res.data.proposals[0].action).toBe('promote');
    expect(res.data.total).toBe(1);
  });

  it('returns nothing to consolidate when there are no captures', async () => {
    const svc = new LearningService({
      rag: await buildRag({ '02-knowledge/x.md': '# X\n\nonly knowledge' }),
      llm: new FakeCompleter(),
    });
    const res = await svc.consolidate();
    expect(res.data.proposals).toEqual([]);
  });

  it('surfaces gaps', async () => {
    const svc = new LearningService({ rag: await buildRag(VAULT), llm: new FakeCompleter() });
    const res = await svc.findGaps();
    expect(res.success).toBe(true);
    expect(res.data.gaps[0].topic).toBe('Tests E2E');
  });
});

describe('Learning — feedback injected into ask-cerveau', () => {
  it('prepends the learnings to the question', async () => {
    class CapturingGenerator implements AnswerGenerator {
      readonly model = 'fake';
      lastQuestion = '';
      async generate(question: string): Promise<GenResult> {
        this.lastQuestion = question;
        return { answer: 'ok', refused: false };
      }
    }
    const gen = new CapturingGenerator();
    const rag = await buildRag({ 'a.md': '# A\n\nredis pattern' }, gen);
    rag.setLearningsProvider(async () => 'Réponds toujours en français.');

    const res = await rag.askCerveau({ question: 'parle de redis' });
    expect(res.success).toBe(true);
    expect(gen.lastQuestion).toContain('Réponds toujours en français.');
    expect(gen.lastQuestion).toContain('parle de redis');
  });
});
