import { promises as fs } from 'fs';
import path from 'path';
import { chunkNote, toWikilink } from '@/services/rag/chunker';
import { dot, normalize } from '@/services/rag/cosine';
import { BM25Index, rrf } from '@/services/rag/bm25';
import type { Reranker } from '@/services/rag/reranker';
import type {
  AnswerGenerator,
  Chunk,
  EmbeddedChunk,
  EmbeddingProvider,
  GenContext,
  RefreshResult,
  SearchHit,
  VaultReader,
} from '@/services/rag/types';
import type { ToolResponse } from '@/mcp/handlers/types';

const INDEX_VERSION = 1;
const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 30;
const MAX_CONTEXT_CHARS = 12000; // budget for ask-cerveau prompt context
const EXCERPT_CHARS = 240;
const RERANK_POOL = 24; // shortlist size handed to the reranker

export interface RagServiceOptions {
  reader: VaultReader;
  embedder: EmbeddingProvider;
  /** Null when ANTHROPIC_API_KEY is absent — ask-cerveau then reports unavailable. */
  generator: AnswerGenerator | null;
  /** Absolute path to the persisted index JSON. */
  indexFile: string;
  /** When false, the index lives purely in memory (used by tests). */
  persist?: boolean;
  /** Blend BM25 (lexical) with dense vectors via RRF. Default true. */
  hybrid?: boolean;
  /** Optional reranker applied to the fused shortlist. Default null (off). */
  reranker?: Reranker | null;
}

interface SearchArgs {
  query: string;
  top_k?: number;
  folder?: string;
  tags?: string[];
}

interface AskArgs {
  question: string;
  top_k?: number;
  folder?: string;
  tags?: string[];
}

interface PersistedChunk {
  id: string;
  file: string;
  title: string;
  heading: string;
  tags: string[];
  text: string;
  hash: string;
  /** base64-encoded Float32 vector. */
  vector: string;
}

interface PersistedIndex {
  version: number;
  embeddingModel: string;
  chunks: PersistedChunk[];
}

/**
 * Holds the embedded vault index in memory and answers semantic queries.
 *
 * Lifecycle: `ensureReady()` lazily loads the persisted index (or builds it on
 * first use); `refresh()` rebuilds incrementally — only chunks whose content
 * hash changed are re-embedded. A single-flight guard serialises refreshes so a
 * webhook reindex can't race the boot build.
 */
export class RagService {
  private readonly reader: VaultReader;
  private readonly embedder: EmbeddingProvider;
  private readonly generator: AnswerGenerator | null;
  private readonly indexFile: string;
  private readonly persist: boolean;
  private readonly hybrid: boolean;
  private readonly reranker: Reranker | null;

  private chunks: EmbeddedChunk[] = [];
  private bm25: BM25Index | null = null;
  private learningsProvider: (() => Promise<string>) | null = null;
  private loaded = false;
  private loadingPromise: Promise<void> | null = null;
  private refreshPromise: Promise<RefreshResult> | null = null;

  constructor(options: RagServiceOptions) {
    this.reader = options.reader;
    this.embedder = options.embedder;
    this.generator = options.generator;
    this.indexFile = options.indexFile;
    this.persist = options.persist ?? true;
    this.hybrid = options.hybrid ?? true;
    this.reranker = options.reranker ?? null;
  }

  get canGenerate(): boolean {
    return this.generator !== null;
  }

  /** Read-only view of the in-memory embedded chunks (consumed by Synapses). */
  get embeddedChunks(): readonly EmbeddedChunk[] {
    return this.chunks;
  }

  /** Inject the feedback memory (`_learnings.md`), prepended to ask-cerveau prompts. */
  setLearningsProvider(fn: () => Promise<string>): void {
    this.learningsProvider = fn;
  }

  private buildLexicalIndex(): void {
    this.bm25 = this.hybrid ? new BM25Index(this.chunks.map(c => c.text)) : null;
  }

  /** Ensure the index is available, loading from disk or building on first use. */
  async ensureReady(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadingPromise) {
      this.loadingPromise = this.initialLoad().finally(() => {
        this.loadingPromise = null;
      });
    }
    await this.loadingPromise;
  }

  private async initialLoad(): Promise<void> {
    if (this.persist && (await this.tryLoad())) {
      this.loaded = true;
      return;
    }
    await this.refresh();
  }

  /** Rebuild the index, re-embedding only changed/new chunks. Single-flight. */
  async refresh(): Promise<RefreshResult> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<RefreshResult> {
    const files = await this.reader.listMarkdownFiles();

    const allChunks: Chunk[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await this.reader.readFile(file);
      } catch {
        continue; // skip unreadable file, don't abort the whole index
      }
      allChunks.push(...chunkNote(file, content));
    }

    // Reuse existing embeddings for unchanged chunk hashes.
    const existing = new Map<string, Float32Array>();
    for (const chunk of this.chunks) existing.set(chunk.hash, chunk.embedding);

    const toEmbed: Chunk[] = [];
    const queued = new Set<string>();
    for (const chunk of allChunks) {
      if (!existing.has(chunk.hash) && !queued.has(chunk.hash)) {
        queued.add(chunk.hash);
        toEmbed.push(chunk);
      }
    }

    const fresh = new Map<string, Float32Array>();
    if (toEmbed.length > 0) {
      const vectors = await this.embedder.embed(toEmbed.map(c => c.text));
      toEmbed.forEach((chunk, i) => fresh.set(chunk.hash, normalize(vectors[i])));
    }

    this.chunks = allChunks.map(chunk => ({
      ...chunk,
      embedding: existing.get(chunk.hash) ?? fresh.get(chunk.hash)!,
    }));
    this.buildLexicalIndex();
    this.loaded = true;

    if (this.persist) await this.save();

    return { files: files.length, chunks: this.chunks.length, embedded: toEmbed.length };
  }

  /** Semantic retrieval over the vault. Returns a ToolResponse envelope. */
  async searchCerveau(args: SearchArgs): Promise<ToolResponse> {
    try {
      await this.ensureReady();
      const hits = await this.retrieve(args.query, args);
      return ok({
        results: hits.map(h => ({
          path: h.path,
          wikilink: h.wikilink,
          heading: h.heading,
          tags: h.tags,
          score: h.score,
          excerpt: h.excerpt,
        })),
        total: hits.length,
      });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  /** Full RAG: retrieve, then have Claude write a grounded, cited answer. */
  async askCerveau(args: AskArgs): Promise<ToolResponse> {
    try {
      if (!this.generator) {
        return fail('ask-cerveau requires ANTHROPIC_API_KEY to be configured on the server.');
      }
      await this.ensureReady();

      const hits = await this.retrieve(args.question, args);
      if (hits.length === 0) {
        return ok({
          answer: 'Je ne trouve rien de pertinent dans tes notes pour cette question.',
          citations: [],
          used_chunks: 0,
        });
      }

      const { contexts, used } = this.budgetContexts(hits);
      const result = await this.generator.generate(await this.withLearnings(args.question), contexts);
      if (result.refused) {
        return fail('La génération a été refusée par le modèle (stop_reason: refusal).');
      }

      return ok({
        answer: result.answer,
        citations: used.map(h => ({
          path: h.path,
          wikilink: h.wikilink,
          heading: h.heading,
          score: h.score,
          excerpt: h.excerpt,
        })),
        used_chunks: used.length,
      });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  private async retrieve(
    query: string,
    filters: { top_k?: number; folder?: string; tags?: string[] },
  ): Promise<SearchHit[]> {
    const topK = clampTopK(filters.top_k);
    const [raw] = await this.embedder.embed([query]);
    const queryVec = normalize(raw);

    // Filter to candidate chunk indices.
    const candidates: number[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (filters.folder && !c.file.startsWith(filters.folder)) continue;
      if (filters.tags && filters.tags.length > 0 && !filters.tags.some(t => c.tags.includes(t)))
        continue;
      candidates.push(i);
    }
    if (candidates.length === 0) return [];

    // Dense ranking (cosine over normalised vectors).
    const denseScore = new Map<number, number>();
    for (const i of candidates) denseScore.set(i, dot(queryVec, this.chunks[i].embedding));
    const denseRanked = [...candidates].sort((a, b) => denseScore.get(b)! - denseScore.get(a)!);

    // Hybrid: blend with BM25 (lexical) via Reciprocal Rank Fusion.
    let ranked = denseRanked;
    if (this.hybrid && this.bm25) {
      const bm25Score = this.bm25.score(query, candidates);
      if (bm25Score.size > 0) {
        const bm25Ranked = [...bm25Score.keys()].sort(
          (a, b) => bm25Score.get(b)! - bm25Score.get(a)!,
        );
        ranked = rrf([denseRanked, bm25Ranked]);
      }
    }

    // Optional rerank over the fused shortlist (cross-encoder style).
    if (this.reranker && ranked.length > 1) {
      const pool = ranked.slice(0, RERANK_POOL);
      try {
        const order = await this.reranker.rerank(
          query,
          pool.map(i => ({ id: String(i), text: this.chunks[i].text })),
        );
        const reordered = order.map(Number).filter(i => Number.isInteger(i) && denseScore.has(i));
        if (reordered.length > 0) {
          const seen = new Set(reordered);
          ranked = [...reordered, ...ranked.filter(i => !seen.has(i))];
        }
      } catch {
        // rerank failure is non-fatal — keep the fused order
      }
    }

    return ranked.slice(0, topK).map(i => {
      const chunk = this.chunks[i];
      return {
        path: chunk.file,
        wikilink: toWikilink(chunk.file),
        heading: chunk.heading,
        tags: chunk.tags,
        score: Math.round((denseScore.get(i) ?? 0) * 1000) / 1000,
        excerpt: excerpt(chunk.text),
        text: chunk.text,
      };
    });
  }

  /** Prepend the feedback memory to a question so the answer respects it. */
  private async withLearnings(question: string): Promise<string> {
    if (!this.learningsProvider) return question;
    const learnings = await this.learningsProvider().catch(() => '');
    return learnings
      ? `[Préférences et corrections de Darius — respecte-les]\n${learnings}\n\n${question}`
      : question;
  }

  private budgetContexts(hits: SearchHit[]): { contexts: GenContext[]; used: SearchHit[] } {
    const contexts: GenContext[] = [];
    const used: SearchHit[] = [];
    let total = 0;
    for (const hit of hits) {
      total += hit.text.length;
      if (contexts.length > 0 && total > MAX_CONTEXT_CHARS) break;
      contexts.push({
        path: hit.path,
        wikilink: hit.wikilink,
        heading: hit.heading,
        text: hit.text,
      });
      used.push(hit);
    }
    return { contexts, used };
  }

  // --- persistence ---------------------------------------------------------

  private async tryLoad(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.indexFile, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedIndex;
      if (parsed.version !== INDEX_VERSION || parsed.embeddingModel !== this.embedder.model) {
        return false; // schema or model changed → rebuild
      }
      this.chunks = parsed.chunks.map(c => ({
        id: c.id,
        file: c.file,
        title: c.title,
        heading: c.heading,
        tags: c.tags,
        text: c.text,
        hash: c.hash,
        embedding: decodeVector(c.vector),
      }));
      this.buildLexicalIndex();
      return this.chunks.length > 0;
    } catch {
      return false;
    }
  }

  private async save(): Promise<void> {
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      embeddingModel: this.embedder.model,
      chunks: this.chunks.map(c => ({
        id: c.id,
        file: c.file,
        title: c.title,
        heading: c.heading,
        tags: c.tags,
        text: c.text,
        hash: c.hash,
        vector: encodeVector(c.embedding),
      })),
    };
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true });
    await fs.writeFile(this.indexFile, JSON.stringify(payload), 'utf-8');
  }
}

function clampTopK(value: number | undefined): number {
  if (!value || value < 1) return DEFAULT_TOP_K;
  return Math.min(Math.floor(value), MAX_TOP_K);
}

function excerpt(text: string): string {
  const body = text.split('\n\n').slice(1).join('\n\n').trim() || text.trim();
  const collapsed = body.replace(/\s+/g, ' ');
  return collapsed.length > EXCERPT_CHARS ? `${collapsed.slice(0, EXCERPT_CHARS)}…` : collapsed;
}

function encodeVector(vector: Float32Array): string {
  const copy = Float32Array.from(vector);
  return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength).toString('base64');
}

function decodeVector(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64');
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(aligned);
}

function ok(data: Record<string, unknown>): ToolResponse {
  return { success: true, data, metadata: { timestamp: new Date().toISOString() } };
}

function fail(error: string): ToolResponse {
  return { success: false, error, metadata: { timestamp: new Date().toISOString() } };
}
