import { describe, expect, it } from 'vitest';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { RagService } from '@/services/rag/rag-service';
import { normalize } from '@/services/rag/cosine';
import { SynapsesService } from '@/services/synapses/synapses-service';
import { aggregateNotes, clusterNotes } from '@/services/synapses/cluster';
import { extractWikilinks } from '@/services/synapses/wikilinks';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import type { LlmCompleter, NoteVector } from '@/services/synapses/types';

// Same toy embedder shape as the RAG tests: count vector over a small vocab.
const VOCAB = ['stripe', 'redis', 'django', 'rag', 'vault'];
function toVector(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map(word => (lower.match(new RegExp(word, 'g')) ?? []).length);
}

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake-embedder';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(toVector);
  }
}

/** Returns canned JSON keyed off which Synapses system prompt is in play. */
class FakeCompleter implements LlmCompleter {
  readonly model = 'fake-llm';
  calls = 0;
  async complete(system: string): Promise<string> {
    this.calls++;
    if (system.includes('worthwhile')) {
      return JSON.stringify([
        { n: 1, worthwhile: true, reason: 'même sujet', liaison: 'Les deux décrivent Redis.' },
      ]);
    }
    if (system.includes('contradiction')) {
      return JSON.stringify([{ n: 1, type: 'contradiction', explanation: 'Décisions opposées.' }]);
    }
    if (system.includes('nom de thème')) {
      return JSON.stringify([
        { n: 1, name: 'Redis', summary: 'Notes autour de Redis.' },
        { n: 2, name: 'Stripe', summary: 'Notes autour de Stripe.' },
      ]);
    }
    return '[]';
  }
}

function makeReader(vault: InMemoryVaultManager): VaultReader {
  return {
    async listMarkdownFiles() {
      return vault.listFiles('', { recursive: true, fileTypes: ['md'] });
    },
    readFile: p => vault.readFile(p),
  };
}

async function buildRag(files: Record<string, string>): Promise<RagService> {
  const rag = new RagService({
    reader: makeReader(new InMemoryVaultManager(files)),
    embedder: new FakeEmbedder(),
    generator: null,
    indexFile: '/unused',
    persist: false,
  });
  await rag.ensureReady();
  return rag;
}

describe('Synapses — wikilinks', () => {
  it('extracts normalised link targets (alias, path, heading)', () => {
    const links = extractWikilinks('See [[alpha]], [[folder/beta|Beta]] and [[Gamma#section]].');
    expect(links.has('alpha')).toBe(true);
    expect(links.has('beta')).toBe(true);
    expect(links.has('gamma')).toBe(true);
  });
});

describe('Synapses — clustering', () => {
  it('groups notes by cosine into connected components', () => {
    const mk = (file: string, vec: number[]): NoteVector => ({
      file,
      title: file,
      tags: [],
      wikilink: file,
      embedding: normalize(vec),
      sample: file,
      body: file,
    });
    const notes = [mk('a', [1, 0, 0, 0, 0]), mk('b', [1, 0, 0, 0, 0]), mk('c', [0, 1, 0, 0, 0])];
    const clusters = clusterNotes(notes, 0.5);
    expect(clusters.length).toBe(2);
    expect(clusters[0].length).toBe(2); // a + b (largest first)
  });

  it('aggregates one normalised vector per note', async () => {
    const rag = await buildRag({
      '02-knowledge/redis/r.md': '---\ntags: [redis]\n---\n# Redis\n\nredis redis pattern',
    });
    const notes = aggregateNotes(rag.embeddedChunks);
    expect(notes).toHaveLength(1);
    const len = Math.hypot(...Array.from(notes[0].embedding));
    expect(len).toBeCloseTo(1, 5);
  });
});

describe('Synapses — suggest-links', () => {
  const VAULT = {
    '02-knowledge/redis/redis-a.md': '---\ntags: [redis]\n---\n# Redis A\n\nredis redis pattern',
    '05-projects/smn/redis-b.md': '---\ntags: [redis]\n---\n# Redis B\n\nredis redis channels',
    '02-knowledge/django/django-a.md':
      '---\ntags: [django]\n---\n# Django A\n\ndjango django, voir [[django-b]]',
    '05-projects/x/django-b.md': '---\ntags: [django]\n---\n# Django B\n\ndjango django orm',
  };

  it('suggests an unlinked cross-folder pair and skips already-linked notes', async () => {
    const rag = await buildRag(VAULT);
    const synapses = new SynapsesService({ rag, llm: new FakeCompleter() });

    const res = await synapses.suggestLinks({});
    expect(res.success).toBe(true);
    expect(res.data.suggestions.length).toBe(1);

    const s = res.data.suggestions[0];
    const pair = [s.a, s.b].sort();
    expect(pair).toEqual(['02-knowledge/redis/redis-a.md', '05-projects/smn/redis-b.md']);
    // django-a → [[django-b]] is already linked, so it must not be suggested.
    expect(
      res.data.suggestions.some((x: any) => x.a.includes('django') || x.b.includes('django')),
    ).toBe(false);
  });
});

describe('Synapses — audit-coherence', () => {
  it('flags overlapping decision notes', async () => {
    const rag = await buildRag({
      '05-projects/smn/decisions/2026-01-redis.md':
        '---\ntags: [decision]\n---\n# Redis DB0\n\nredis redis: messages en db0',
      '05-projects/smn/decisions/2026-02-redis.md':
        '---\ntags: [decision]\n---\n# Redis DB1\n\nredis redis: messages en db1',
    });
    const synapses = new SynapsesService({ rag, llm: new FakeCompleter() });

    const res = await synapses.auditCoherence({});
    expect(res.success).toBe(true);
    expect(res.data.issues.length).toBe(1);
    expect(res.data.issues[0].type).toBe('contradiction');
  });
});

describe('Synapses — find-themes', () => {
  it('clusters the vault and names the themes', async () => {
    const rag = await buildRag({
      '01-raw/r1.md': '# r1\n\nredis redis',
      '02-knowledge/redis/r2.md': '# r2\n\nredis redis',
      '05-projects/p/r3.md': '# r3\n\nredis redis',
      '02-knowledge/stripe/s1.md': '# s1\n\nstripe stripe',
      '05-projects/p/s2.md': '# s2\n\nstripe stripe',
      '01-raw/s3.md': '# s3\n\nstripe stripe',
    });
    const synapses = new SynapsesService({ rag, llm: new FakeCompleter() });

    const res = await synapses.findThemes({});
    expect(res.success).toBe(true);
    expect(res.data.themes.length).toBe(2);
    expect(res.data.themes.every((t: any) => t.name.length > 0)).toBe(true);
    expect(res.data.themes.every((t: any) => t.notes.length >= 3)).toBe(true);
  });
});

describe('Synapses — digest', () => {
  it('renders a markdown digest from all three analyses', async () => {
    const rag = await buildRag({
      '02-knowledge/redis/redis-a.md': '---\ntags: [redis]\n---\n# Redis A\n\nredis redis pattern',
      '05-projects/smn/redis-b.md': '---\ntags: [redis]\n---\n# Redis B\n\nredis redis channels',
    });
    const llm = new FakeCompleter();
    const synapses = new SynapsesService({ rag, llm });

    const res = await synapses.digest();
    expect(res.success).toBe(true);
    expect(res.data.markdown).toContain('# 🧬 Synapses');
    expect(res.data.markdown).toContain('Liens manquants');
    expect(res.data.markdown).toContain('Cohérence');
    expect(res.data.markdown).toContain('Thèmes');
    // Cost bound: at most one LLM call per capability (≤3), never N-per-pair.
    expect(llm.calls).toBeGreaterThan(0);
    expect(llm.calls).toBeLessThanOrEqual(3);
  });
});
