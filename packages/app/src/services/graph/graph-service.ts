import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { toWikilink } from '@/services/rag/chunker';
import { KnowledgeGraph } from '@/services/graph/knowledge-graph';
import type { GraphEdgeView } from '@/services/graph/knowledge-graph';
import type { GraphExtraction, GraphLlm } from '@/services/graph/types';
import type { RagService } from '@/services/rag/rag-service';
import type { ToolResponse } from '@/mcp/handlers/types';

const GRAPH_VERSION = 1;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;
const MAX_NOTE_EXCERPTS = 8;
const MAX_TRIPLES = 60;
const EXCERPT_CHARS = 300;

const isExcluded = (file: string): boolean =>
  file === '00-synapses.md' || file.startsWith('_templates/');

interface CachedExtraction {
  hash: string;
  extraction: GraphExtraction;
}
interface PersistedGraph {
  version: number;
  notes: Record<string, CachedExtraction>;
}

export interface GraphServiceOptions {
  rag: RagService;
  llm: GraphLlm;
  graphFile: string;
  persist?: boolean;
}
export interface GraphBuildResult {
  notes: number;
  extracted: number;
  entities: number;
  relations: number;
}

/**
 * GraphRAG service. Builds a knowledge graph by extracting entities/relations
 * per note (incremental — only re-extracts notes whose content hash changed),
 * persists the per-note extractions, and answers multi-hop questions by
 * expanding the graph around the query's entities. Reuses the RAG chunks for
 * note text (no extra git sync). Single-flight build.
 */
export class GraphService {
  private readonly rag: RagService;
  private readonly llm: GraphLlm;
  private readonly graphFile: string;
  private readonly persist: boolean;

  private cache = new Map<string, CachedExtraction>();
  private graph = new KnowledgeGraph();
  private loaded = false;
  private buildPromise: Promise<GraphBuildResult> | null = null;

  constructor(o: GraphServiceOptions) {
    this.rag = o.rag;
    this.llm = o.llm;
    this.graphFile = o.graphFile;
    this.persist = o.persist ?? true;
  }

  async ensureReady(): Promise<void> {
    if (!this.loaded) await this.build();
  }

  /** Build or incrementally update the graph. Single-flight. */
  async build(): Promise<GraphBuildResult> {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this.doBuild().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  private async doBuild(): Promise<GraphBuildResult> {
    if (this.persist && this.cache.size === 0) await this.tryLoad();
    await this.rag.ensureReady();
    const notes = this.noteTexts();

    let extracted = 0;
    const nextCache = new Map<string, CachedExtraction>();
    for (const [file, text] of notes) {
      const hash = sha256(text);
      const cached = this.cache.get(file);
      if (cached && cached.hash === hash) {
        nextCache.set(file, cached);
      } else {
        const extraction = await this.llm.extract(text);
        nextCache.set(file, { hash, extraction });
        extracted++;
      }
    }
    this.cache = nextCache;

    const g = new KnowledgeGraph();
    for (const [file, c] of this.cache) g.addNote(file, c.extraction);
    this.graph = g;
    this.loaded = true;

    if (this.persist) await this.save();
    return { notes: notes.size, extracted, entities: g.size.entities, relations: g.size.relations };
  }

  /** Per-note text reconstructed from RAG chunks (avoids a second vault read). */
  private noteTexts(): Map<string, string> {
    const map = new Map<string, string>();
    for (const c of this.rag.embeddedChunks) {
      if (isExcluded(c.file)) continue;
      map.set(c.file, (map.get(c.file) ?? '') + c.text + '\n');
    }
    return map;
  }

  private excerptFor(file: string): string {
    for (const c of this.rag.embeddedChunks) {
      if (c.file === file) {
        const body = c.text.replace(/\s+/g, ' ').trim();
        return body.length > EXCERPT_CHARS ? `${body.slice(0, EXCERPT_CHARS)}…` : body;
      }
    }
    return '';
  }

  // --- tools --------------------------------------------------------------

  /** Multi-hop QA: expand the graph around the query's entities, then synthesize. */
  async graphAsk(args: { question: string; depth?: number }): Promise<ToolResponse> {
    try {
      await this.ensureReady();
      const seeds = this.graph.matchEntities(args.question);
      if (seeds.length === 0) {
        return ok({
          answer: 'Aucune entité du graphe ne correspond à cette question.',
          entities: [],
          relations: [],
          notes: [],
        });
      }
      const keys = this.graph.expand(seeds, clampDepth(args.depth));
      const relations = this.graph.edgesWithin(keys);
      const noteFiles = this.graph.notesFor(keys).slice(0, MAX_NOTE_EXCERPTS);
      const answer = await this.llm.synthesize(
        args.question,
        this.buildContext(relations, noteFiles),
      );
      return ok({
        answer,
        entities: [...keys].map(k => this.graph.nodeName(k)),
        relations: relations.map(r => ({
          source: r.source,
          relation: r.relation,
          target: r.target,
        })),
        notes: noteFiles.map(f => ({ path: f, wikilink: toWikilink(f) })),
      });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  /** Structural view: graph size, communities (connected components), hub entities. */
  async graphOverview(args: { min_cluster_size?: number } = {}): Promise<ToolResponse> {
    try {
      await this.ensureReady();
      const communities = this.graph
        .communities(clampMin(args.min_cluster_size))
        .slice(0, 12)
        .map(c => ({ id: c.id, size: c.size, entities: c.entities.slice(0, 20) }));
      const hubs = this.graph
        .topEntities(12)
        .map(n => ({ name: n.name, degree: n.degree, notes: n.mentions.length }));
      const { entities, relations } = this.graph.size;
      return ok({ entities, relations, communities, hubs });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  /** Nodes + links for the web graph visualization (top-N most-connected entities). */
  async graphData(args: { limit?: number } = {}): Promise<ToolResponse> {
    try {
      await this.ensureReady();
      const limit = Math.max(10, Math.min(300, Math.floor(args.limit ?? 150)));
      const data = this.graph.graphData(limit);
      return ok({ nodes: data.nodes, links: data.links });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  private buildContext(relations: GraphEdgeView[], noteFiles: string[]): string {
    const triples = relations
      .slice(0, MAX_TRIPLES)
      .map(r => `${r.source} —${r.relation}→ ${r.target}`)
      .join('\n');
    const notes = noteFiles.map(f => `[[${toWikilink(f)}]] : ${this.excerptFor(f)}`).join('\n');
    return `Relations :\n${triples || '(aucune)'}\n\nNotes connectées :\n${notes || '(aucune)'}`;
  }

  // --- persistence --------------------------------------------------------

  private async tryLoad(): Promise<void> {
    try {
      const raw = await fs.readFile(this.graphFile, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedGraph;
      if (parsed.version === GRAPH_VERSION && parsed.notes) {
        this.cache = new Map(Object.entries(parsed.notes));
      }
    } catch {
      /* no cache yet — first build extracts everything */
    }
  }

  private async save(): Promise<void> {
    const payload: PersistedGraph = {
      version: GRAPH_VERSION,
      notes: Object.fromEntries(this.cache),
    };
    await fs.mkdir(path.dirname(this.graphFile), { recursive: true });
    await fs.writeFile(this.graphFile, JSON.stringify(payload), 'utf-8');
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function clampDepth(value: number | undefined): number {
  if (!value || value < 1) return DEFAULT_DEPTH;
  return Math.min(Math.floor(value), MAX_DEPTH);
}
function clampMin(value: number | undefined): number {
  if (!value || value < 2) return 3;
  return Math.min(Math.floor(value), 20);
}
function ok(data: Record<string, unknown>): ToolResponse {
  return { success: true, data, metadata: { timestamp: new Date().toISOString() } };
}
function fail(error: string): ToolResponse {
  return { success: false, error, metadata: { timestamp: new Date().toISOString() } };
}
