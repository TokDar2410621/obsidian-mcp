import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { RagService } from '@/services/rag/rag-service';
import { GraphService } from '@/services/graph/graph-service';
import { KnowledgeGraph } from '@/services/graph/knowledge-graph';
import { parseExtraction, stripLoneSurrogates } from '@/services/graph/graph-llm';
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

describe('GraphRAG — une note ne coule pas le build entier', () => {
  const VAULT = {
    'a.md': '# A\n\nRedis powers SendMeNow',
    'b.md': '# B\n\nStripe and Redis',
    'c.md': '# C\n\nRedis and Stripe again',
  };

  /** Reproduit la panne vecue du 2026-08-18 : une note fait repondre 400 a l'API. */
  class ThrowsOnOneNote extends FakeGraphLlm {
    async extract(text: string): Promise<GraphExtraction> {
      if (text.includes('Stripe and Redis')) {
        this.extractCalls++;
        throw new Error('400 invalid high surrogate in string');
      }
      return super.extract(text);
    }
  }

  it('garde les extractions deja payees quand une note jette', async () => {
    const rag = await buildRag(VAULT);
    const llm = new ThrowsOnOneNote();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    // Avant ce correctif, l'exception remontait hors de doBuild : ni le cache
    // ni le graphe n'etaient poses, et tout le travail deja facture etait jete.
    const r = await graph.build();
    expect(r.entities).toBeGreaterThan(0); // le travail des notes saines survit
  });

  it('ne re-extrait pas les notes saines au build suivant', async () => {
    const rag = await buildRag(VAULT);
    const llm = new ThrowsOnOneNote();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    await graph.build();
    const apresPremier = llm.extractCalls;
    await graph.build();
    // Le cache des saines a bien ete pose : le second build coute moins cher.
    expect(llm.extractCalls - apresPremier).toBeLessThan(apresPremier);
  });
});

describe('GraphRAG — surrogates orphelins', () => {
  it('retire la moitie de paire laissee par le decoupage en fenetres', () => {
    const emoji = '\u{1F600}';
    const moitie = emoji.slice(0, 1); // high surrogate seul, ce que windowText produit
    expect(stripLoneSurrogates(`avant ${moitie} apres`)).toBe('avant  apres');
    expect(stripLoneSurrogates(`ok ${emoji} ok`)).toBe(`ok ${emoji} ok`); // paire intacte
  });

  it('neutralise le faux gras LinkedIn coupe en deux (le poison reel)', () => {
    const gras = '\u{1D5F2}'; // MATHEMATICAL SANS-SERIF BOLD SMALL E
    const coupe = gras.slice(0, 1);
    const nettoye = stripLoneSurrogates(`texte${coupe}suite`);
    expect(nettoye).toBe('textesuite');
    expect(nettoye).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe('GraphRAG — echoes par wikilinks (association native, sans LLM)', () => {
  /** LLM aveugle : toutes les extractions sont vides. */
  class BlindGraphLlm extends FakeGraphLlm {
    async extract(): Promise<GraphExtraction> {
      this.extractCalls++;
      return { entities: [], relations: [] };
    }
  }

  it('les liens sortants et retroliens produisent des echos meme sans entites', async () => {
    const rag = await buildRag({
      'projets/source.md': 'Voir [[cible]] et [[hub|le hub]].',
      'projets/cible.md': 'Contenu de la cible.',
      'dossier/hub.md': 'Le hub.',
      'ailleurs/retour.md': 'Je pointe vers [[source]].',
      'ailleurs/etranger.md': 'Aucun lien ici.',
    });
    const graph = new GraphService({ rag, llm: new BlindGraphLlm(), graphFile: '/unused', persist: false });
    await graph.build();
    const echoes = await graph.echoesFor(['projets/source.md'], 5);
    const files = echoes.map(e => e.file);
    expect(files).toContain('projets/cible.md'); // lien sortant
    expect(files).toContain('dossier/hub.md'); // lien avec alias
    expect(files).toContain('ailleurs/retour.md'); // retrolien
    expect(files).not.toContain('ailleurs/etranger.md');
    expect(files).not.toContain('projets/source.md'); // jamais la note declencheuse
  });

  it('garde une bonne extraction quand la re-extraction echoue (pas de regression)', async () => {
    const rag = await buildRag({ 'note.md': 'SendMeNow utilise Redis pour tout. '.repeat(20) });
    // Premier build : extraction OK (entites). On simule ensuite un LLM en panne.
    class OkThenBlind extends FakeGraphLlm {
      blind = false;
      async extract(text: string): Promise<GraphExtraction> {
        this.extractCalls++;
        if (this.blind) return { entities: [], relations: [] };
        return super.extract(text);
      }
    }
    const llm = new OkThenBlind();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });
    const first = await graph.build();
    expect(first.entities).toBeGreaterThan(0);
    // La note change (nouveau contenu indexe), le LLM tombe en panne.
    llm.blind = true;
    await rag.refresh(); // meme contenu : pour changer le hash il faudrait un reader mutable;
    // on verifie au moins que le cache tient et que l'etat reste sain.
    const second = await graph.build();
    expect(second.entities).toBeGreaterThan(0); // pas de regression a vide
  });
});

describe('GraphRAG — reponses tronquees', () => {
  // Constate en production le 2026-09-05 : le modele repondait un JSON valide,
  // max_tokens=1024 le coupait avant l'accolade fermante, JSON.parse jetait, et
  // le `catch` nu rendait « vide ». 695 notes ont ete comptees vides pour ca.
  it('sauve les entites d un JSON coupe en plein tableau', () => {
    const coupe = '{\n  "entities": [\n    "Redis",\n    "SendMeNow",\n    "Stri';
    const r = parseExtraction(coupe);
    expect(r.entities).toContain('Redis');
    expect(r.entities).toContain('SendMeNow');
  });

  it('sauve les triplets complets et jette les triplets coupes', () => {
    const coupe =
      '{"entities":["A","B"],"relations":[{"source":"A","relation":"utilise","target":"B"},{"source":"C","rela';
    const r = parseExtraction(coupe);
    expect(r.entities).toEqual(['A', 'B']);
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toEqual({ source: 'A', relation: 'utilise', target: 'B' });
  });

  it('ne casse pas sur du vrai vide', () => {
    expect(parseExtraction('').entities).toEqual([]);
    expect(parseExtraction('aucune entite ici').entities).toEqual([]);
  });

  it('un JSON complet passe toujours par le chemin normal', () => {
    const bon = '{"entities":["Redis"],"relations":[{"source":"Redis","relation":"sert","target":"App"}]}';
    const r = parseExtraction(bon);
    expect(r.entities).toEqual(['Redis']);
    expect(r.relations).toHaveLength(1);
  });
});

describe('GraphRAG — removeNote (batissage differentiel)', () => {
  const extraction = (entities: string[], relations: Array<[string, string, string]> = []) => ({
    entities,
    relations: relations.map(([source, relation, target]) => ({ source, relation, target })),
  });

  it('retire les noeuds orphelins mais garde les entites encore citees ailleurs', () => {
    const g = new KnowledgeGraph();
    g.addNote('a.md', extraction(['Redis', 'SendMeNow'], [['Redis', 'sert', 'SendMeNow']]));
    g.addNote('b.md', extraction(['Redis', 'Stripe'], [['Redis', 'facture via', 'Stripe']]));

    g.removeNote('a.md');

    // SendMeNow n'etait cite que par a.md : il disparait, avec son arete.
    expect(g.matchEntities('SendMeNow')).toHaveLength(0);
    // Redis est encore cite par b.md : il survit.
    expect(g.matchEntities('Redis')).toHaveLength(1);
    expect(g.size.relations).toBe(1); // seule l'arete de b.md reste
  });

  it('nettoie l adjacence : aucune traversee vers un voisin fantome', () => {
    const g = new KnowledgeGraph();
    g.addNote('a.md', extraction(['Redis', 'SendMeNow'], [['Redis', 'sert', 'SendMeNow']]));
    g.addNote('b.md', extraction(['Redis', 'Stripe'], [['Redis', 'facture via', 'Stripe']]));

    g.removeNote('a.md');

    const seeds = g.matchEntities('Redis');
    const atteints = g.expand(seeds, 2);
    const noms = [...atteints].map(k => g.nodeName(k).toLowerCase());
    expect(noms).toContain('stripe');
    expect(noms).not.toContain('sendmenow'); // le voisin fantome, avant le correctif d'adjacence
  });

  it('une arete partagee par deux notes survit au retrait d une seule', () => {
    const g = new KnowledgeGraph();
    g.addNote('a.md', extraction(['Redis', 'Stripe'], [['Redis', 'facture via', 'Stripe']]));
    g.addNote('b.md', extraction(['Redis', 'Stripe'], [['Redis', 'facture via', 'Stripe']]));

    g.removeNote('a.md');
    expect(g.size.relations).toBe(1);
    g.removeNote('b.md');
    expect(g.size).toEqual({ entities: 0, relations: 0 }); // plus rien, pas de residu
  });

  it('retirer puis re-ajouter est le cycle d une mise a jour', () => {
    const g = new KnowledgeGraph();
    g.addNote('a.md', extraction(['Redis']));
    g.removeNote('a.md');
    g.addNote('a.md', extraction(['Stripe']));
    expect(g.matchEntities('Redis')).toHaveLength(0);
    expect(g.matchEntities('Stripe')).toHaveLength(1);
  });
});

describe('GraphRAG — applyChanges (le delta au lieu du balayage)', () => {
  function buildRagMutable(files: Record<string, string>): {
    vault: InMemoryVaultManager;
    rag: RagService;
  } {
    const vault = new InMemoryVaultManager(files);
    const rag = new RagService({
      reader: makeReader(vault),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile: '/unused',
      persist: false,
    });
    return { vault, rag };
  }

  const VAULT = {
    'a.md': '# A\n\nRedis powers SendMeNow',
    'b.md': '# B\n\nStripe and Redis',
    'c.md': '# C\n\nRedis everywhere',
  };

  it('une note changee = une seule extraction, les autres zero', async () => {
    const { vault, rag } = buildRagMutable({ ...VAULT });
    await rag.ensureReady();
    const llm = new FakeGraphLlm();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });
    await graph.build();
    const apresBuild = llm.extractCalls;

    await vault.writeFile('a.md', '# A\n\nRedis now also powers Stripe');
    await rag.refresh();
    const r = await graph.applyChanges(['a.md']);

    expect(r.updated).toBe(1);
    expect(r.extracted).toBe(1);
    expect(llm.extractCalls - apresBuild).toBe(1); // b.md et c.md : zero appel
  });

  it('une note inchangee annoncee changee ne coute rien (garde de hash)', async () => {
    const { rag } = buildRagMutable({ ...VAULT });
    await rag.ensureReady();
    const llm = new FakeGraphLlm();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });
    await graph.build();
    const apresBuild = llm.extractCalls;

    const r = await graph.applyChanges(['a.md', 'b.md', 'c.md']);
    expect(r.extracted).toBe(0);
    expect(llm.extractCalls).toBe(apresBuild);
  });

  it('une note supprimee sort du graphe, sans appel LLM', async () => {
    const { vault, rag } = buildRagMutable({ ...VAULT });
    await rag.ensureReady();
    const llm = new FakeGraphLlm();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });
    const avant = await graph.build();
    const apresBuild = llm.extractCalls;

    await vault.deleteFile('a.md');
    await rag.refresh();
    const r = await graph.applyChanges([], ['a.md']);

    expect(r.removed).toBe(1);
    expect(llm.extractCalls).toBe(apresBuild); // zero appel pour une suppression
    expect(r.entities).toBeLessThanOrEqual(avant.entities);
  });

  it('avant tout build, le delta declenche le build complet une seule fois', async () => {
    const { rag } = buildRagMutable({ ...VAULT });
    await rag.ensureReady();
    const llm = new FakeGraphLlm();
    const graph = new GraphService({ rag, llm, graphFile: '/unused', persist: false });

    const r = await graph.applyChanges(['a.md']);
    expect(r.entities).toBeGreaterThan(0); // le graphe existe desormais
  });
});
