import { describe, expect, it } from 'vitest';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { RagService } from '@/services/rag/rag-service';
import { GraphService } from '@/services/graph/graph-service';
import { KnowledgeGraph } from '@/services/graph/knowledge-graph';
import { parseExtraction } from '@/services/graph/graph-llm';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import type { GraphExtraction, GraphLlm } from '@/services/graph/types';

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0]);
  }
}
function makeReader(vault: InMemoryVaultManager): VaultReader {
  return {
    listMarkdownFiles: () => vault.listFiles('', { recursive: true, fileTypes: ['md'] }),
    readFile: p => vault.readFile(p),
  };
}

/** Derives entities by keyword and links the first two found. */
class FakeGraphLlm implements GraphLlm {
  extractCalls = 0;
  synthCalls = 0;
  async extract(text: string): Promise<GraphExtraction> {
    this.extractCalls++;
    const ents = ['Redis', 'SendMeNow', 'Stripe'].filter(e =>
      text.toLowerCase().includes(e.toLowerCase()),
    );
    const relations =
      ents.length >= 2 ? [{ source: ents[0], relation: 'lié à', target: ents[1] }] : [];
    return { entities: ents, relations };
  }
  async synthesize(question: string, context: string): Promise<string> {
    this.synthCalls++;
    return `Réponse (${question}) depuis ${context.length} chars de graphe.`;
  }
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

describe('GraphRAG — extraction parsing', () => {
  it('parses entities and relations from JSON (tolerating prose)', () => {
    const ex = parseExtraction(
      'Voici: {"entities":["Redis","SMN"],"relations":[{"source":"SMN","relation":"utilise","target":"Redis"}]}',
    );
    expect(ex.entities).toContain('Redis');
    expect(ex.relations[0]).toMatchObject({ source: 'SMN', target: 'Redis' });
  });
  it('returns empty on garbage', () => {
    expect(parseExtraction('no json here')).toEqual({ entities: [], relations: [] });
  });
});

describe('GraphRAG — knowledge graph structure', () => {
  it('builds nodes/edges, matches and expands', () => {
    const g = new KnowledgeGraph();
    g.addNote('a.md', {
      entities: ['Redis', 'SendMeNow'],
      relations: [{ source: 'Redis', relation: 'powers', target: 'SendMeNow' }],
    });
    g.addNote('b.md', {
      entities: ['Stripe', 'Redis'],
      relations: [{ source: 'Stripe', relation: 'with', target: 'Redis' }],
    });

    expect(g.size.entities).toBe(3);
    expect(g.size.relations).toBe(2);

    const seeds = g.matchEntities('redis pattern');
    expect(seeds).toContain('redis');

    const keys = g.expand(seeds, 2);
    expect(keys.size).toBe(3); // redis reaches both sendmenow and stripe

    const comms = g.communities(3);
    expect(comms[0].size).toBe(3);
    expect(g.topEntities(1)[0].name).toBe('Redis'); // highest degree
  });

  it('graphData canonicalizes link endpoints (no dangling links)', () => {
    const g = new KnowledgeGraph();
    g.addNote('a.md', { entities: ['OpenAI'], relations: [] }); // freezes display name "OpenAI"
    g.addNote('b.md', {
      entities: ['SendMeNow'],
      relations: [{ source: 'openai', relation: 'powers', target: 'sendmenow' }], // raw lowercase
    });

    const { nodes, links } = g.graphData(50);
    const ids = new Set(nodes.map(n => n.id));
    expect(ids.has('OpenAI')).toBe(true);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(ids.has(l.source)).toBe(true); // every endpoint exists as a node
      expect(ids.has(l.target)).toBe(true);
    }
  });
});

describe('GraphRAG — service', () => {
  const VAULT = {
    'a.md': '# A\n\nRedis powers SendMeNow',
    'b.md': '# B\n\nStripe and Redis',
  };

  it('builds incrementally (no re-extract when unchanged)', async () => {
    const rag = await buildRag(VAULT);
    const llm = new FakeGraphLlm();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    const r1 = await graph.build();
    expect(r1.entities).toBeGreaterThanOrEqual(3);
    const callsAfterFirst = llm.extractCalls;

    const r2 = await graph.build();
    expect(llm.extractCalls).toBe(callsAfterFirst); // cache hit → no re-extraction
    expect(r2.extracted).toBe(0);
  });

  it('answers a multi-hop question over the graph', async () => {
    const rag = await buildRag(VAULT);
    const llm = new FakeGraphLlm();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    const res = await graph.graphAsk({ question: 'Quel est le lien avec Redis ?' });
    expect(res.success).toBe(true);
    expect(res.data.entities).toContain('Redis');
    expect(res.data.answer.length).toBeGreaterThan(0);
    expect(llm.synthCalls).toBe(1);
  });

  it('exposes graph structure via overview', async () => {
    const rag = await buildRag(VAULT);
    const graph = new GraphService({
      rag,
      llm: new FakeGraphLlm(),
      graphFile: '/unused',
      persist: false,
    });

    const res = await graph.graphOverview({});
    expect(res.success).toBe(true);
    expect(res.data.entities).toBeGreaterThanOrEqual(3);
    expect(res.data.hubs[0].name).toBe('Redis');
  });
});

describe('GraphRAG — self-healing of empty extractions', () => {
  /** Fails N times (returns empty), then succeeds — an LLM hiccup. */
  class FlakyGraphLlm extends FakeGraphLlm {
    constructor(private failures: number) {
      super();
    }
    async extract(text: string): Promise<GraphExtraction> {
      this.extractCalls++;
      if (this.failures > 0) {
        this.failures--;
        return { entities: [], relations: [] };
      }
      return { entities: ['Redis'], relations: [] };
    }
  }

  const BIG = 'Redis '.repeat(80); // > MIN_EXTRACTABLE_CHARS, deserves entities

  it('retries an empty extraction on the next build instead of caching it forever', async () => {
    const rag = await buildRag({ 'note.md': BIG });
    const llm = new FlakyGraphLlm(1); // first build hiccups
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    const first = await graph.build();
    expect(first.entities).toBe(0); // the hiccup left the note blind
    const second = await graph.build();
    expect(second.extracted).toBe(1); // retried, not served from cache
    expect(second.entities).toBe(1); // healed
  });

  it('gives up after bounded retries (a genuinely empty note stays cached)', async () => {
    const rag = await buildRag({ 'note.md': BIG });
    const llm = new FlakyGraphLlm(Number.MAX_SAFE_INTEGER); // always empty
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    await graph.build();
    await graph.build();
    await graph.build();
    await graph.build();
    const calls = llm.extractCalls;
    await graph.build(); // beyond MAX_EMPTY_RETRIES_PER_NOTE: no more calls
    expect(llm.extractCalls).toBe(calls);
  });

  it('never retries short notes (an empty extraction there is legitimate)', async () => {
    const rag = await buildRag({ 'court.md': 'Rien.' });
    const llm = new FlakyGraphLlm(Number.MAX_SAFE_INTEGER);
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });
    await graph.build();
    const calls = llm.extractCalls;
    await graph.build();
    expect(llm.extractCalls).toBe(calls); // cached empty, no retry
  });
});
