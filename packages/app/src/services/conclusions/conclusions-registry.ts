import type { VaultManager } from '@/services/vault-manager';
import { logger } from '@/utils/logger';

/**
 * The cerveau's memory of its OWN conclusions (metacognition). Diagnostic
 * "pensee humaine" gap #1: every proposer (reflection, sweeps, night thinker,
 * ingestion) used to publish without remembering what was already proposed or
 * what Darius refused, hence the same proposal shown 29 times. This registry:
 *   - records every conclusion with a status (propose | valide | refuse |
 *     promu | rejete) fed by the one-tap /revue routes,
 *   - answers "have we already concluded something like this?" by semantic
 *     similarity (cosine over the rag embedder), so a REFORMULATED repeat is
 *     still caught,
 *   - is stored IN the vault (08-auto/_conclusions.json, text + status only,
 *     no vectors) so the PC2 night thinker can read the refusals too.
 * Embeddings are cached in memory per process and recomputed lazily.
 */

export const CONCLUSIONS_FILE = '08-auto/_conclusions.json';
const MAX_ITEMS = 400;
export const DUP_THRESHOLD = 0.85;

export type ConclusionStatus = 'propose' | 'valide' | 'refuse' | 'promu' | 'rejete';

export interface Conclusion {
  id: string;
  text: string;
  source: string;
  status: ConclusionStatus;
  date: string; // YYYY-MM-DD
}

interface RegistryData {
  version: 1;
  items: Conclusion[];
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

const today = () => new Date().toISOString().slice(0, 10);

const normText = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Stable id from the text (djb2 base36), so re-records converge. */
export function conclusionId(text: string): string {
  let h = 5381;
  const s = normText(text).toLowerCase();
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `c-${h.toString(36)}`;
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export class ConclusionsRegistry {
  private data: RegistryData | null = null;
  /** id -> normalized embedding, lazily filled. */
  private vectors = new Map<string, Float32Array>();

  constructor(
    private readonly vault: VaultManager,
    private readonly embed: EmbedFn | null,
  ) {}

  private async load(): Promise<RegistryData> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await this.vault.readFile(CONCLUSIONS_FILE)) as Partial<RegistryData>;
      this.data = { version: 1, items: Array.isArray(parsed.items) ? (parsed.items as Conclusion[]) : [] };
    } catch {
      this.data = { version: 1, items: [] };
    }
    return this.data;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    if (this.data.items.length > MAX_ITEMS) {
      // Drop oldest non-refused first: refusals are the most precious signal.
      const keep = this.data.items.slice();
      while (keep.length > MAX_ITEMS) {
        const idx = keep.findIndex(i => i.status !== 'refuse' && i.status !== 'rejete');
        keep.splice(idx >= 0 ? idx : 0, 1);
      }
      this.data.items = keep;
    }
    await this.vault.writeFile(CONCLUSIONS_FILE, JSON.stringify(this.data, null, 1));
  }

  /** Ensure embeddings exist for every item (one batched call for the missing). */
  private async ensureVectors(): Promise<void> {
    if (!this.embed) return;
    const data = await this.load();
    const missing = data.items.filter(i => !this.vectors.has(i.id));
    if (missing.length === 0) return;
    try {
      const vecs = await this.embed(missing.map(i => normText(i.text)));
      missing.forEach((item, k) => {
        if (vecs[k]) this.vectors.set(item.id, vecs[k]);
      });
    } catch (error) {
      logger.warn('Conclusions: embedding failed, similarity dedup degraded', { error: String(error) });
    }
  }

  /**
   * Best semantically-similar registered conclusion, or null. Falls back to
   * exact/substring matching when no embedder is available.
   */
  async findSimilar(text: string, threshold = DUP_THRESHOLD): Promise<{ item: Conclusion; score: number } | null> {
    const data = await this.load();
    const norm = normText(text).toLowerCase();
    if (!norm) return null;
    const exact = data.items.find(i => normText(i.text).toLowerCase() === norm);
    if (exact) return { item: exact, score: 1 };
    if (!this.embed || data.items.length === 0) return null;
    await this.ensureVectors();
    let queryVec: Float32Array;
    try {
      [queryVec] = await this.embed([normText(text)]);
    } catch {
      return null;
    }
    if (!queryVec) return null;
    let best: { item: Conclusion; score: number } | null = null;
    for (const item of data.items) {
      const v = this.vectors.get(item.id);
      if (!v) continue;
      const score = dot(queryVec, v);
      if (score >= threshold && (!best || score > best.score)) best = { item, score };
    }
    return best;
  }

  /** True when a similar conclusion was REFUSED by Darius: never re-propose. */
  async isRefused(text: string): Promise<boolean> {
    const hit = await this.findSimilar(text);
    return !!hit && (hit.item.status === 'refuse' || hit.item.status === 'rejete');
  }

  /**
   * Record a conclusion (or update the status of the same/similar one).
   * A refusal always wins over an older 'propose'.
   */
  async record(entry: { text: string; source: string; status: ConclusionStatus }): Promise<Conclusion> {
    const data = await this.load();
    const text = normText(entry.text);
    const similar = await this.findSimilar(text, 0.92);
    if (similar) {
      similar.item.status = entry.status;
      similar.item.date = today();
      await this.save();
      return similar.item;
    }
    const item: Conclusion = {
      id: conclusionId(text),
      text: text.slice(0, 300),
      source: entry.source,
      status: entry.status,
      date: today(),
    };
    const existing = data.items.find(i => i.id === item.id);
    if (existing) {
      existing.status = entry.status;
      existing.date = item.date;
      await this.save();
      return existing;
    }
    data.items.push(item);
    await this.save();
    return item;
  }

  /**
   * Batched mask over statuses (ONE embedding call for all queries).
   * mask[k] = true when texts[k] matches a conclusion whose status is in
   * `statuses`. Exact match first, then semantic (cosine >= threshold).
   */
  private async statusMask(
    texts: string[],
    statuses: ConclusionStatus[],
    threshold = DUP_THRESHOLD,
  ): Promise<boolean[]> {
    const data = await this.load();
    const pool = data.items.filter(i => statuses.includes(i.status));
    if (pool.length === 0 || texts.length === 0) return texts.map(() => false);
    const exact = new Set(pool.map(i => normText(i.text).toLowerCase()));
    const mask = texts.map(t => exact.has(normText(t).toLowerCase()));
    if (!this.embed) return mask;
    await this.ensureVectors();
    let qvecs: Float32Array[];
    try {
      qvecs = await this.embed(texts.map(normText));
    } catch {
      return mask;
    }
    texts.forEach((_, k) => {
      if (mask[k] || !qvecs[k]) return;
      for (const item of pool) {
        const v = this.vectors.get(item.id);
        if (v && dot(qvecs[k], v) >= threshold) {
          mask[k] = true;
          return;
        }
      }
    });
    return mask;
  }

  /** mask[k] = true when texts[k] matches a REFUSED conclusion. */
  async refusedMask(texts: string[], threshold = DUP_THRESHOLD): Promise<boolean[]> {
    return this.statusMask(texts, ['refuse', 'rejete'], threshold);
  }

  /**
   * mask[k] = true when texts[k] matches ANY settled conclusion (refused,
   * rejected, validated or promoted). A settled matter never counts as
   * "pending" again, anywhere: this is what stops the brief and /revue from
   * re-serving work that was already done but whose checkbox was never ticked.
   */
  async settledMask(texts: string[], threshold = DUP_THRESHOLD): Promise<boolean[]> {
    return this.statusMask(texts, ['refuse', 'rejete', 'valide', 'promu'], threshold);
  }

  /** Recently refused texts (for prompts / displays). */
  async refusedTexts(max = 40): Promise<string[]> {
    const data = await this.load();
    return data.items
      .filter(i => i.status === 'refuse' || i.status === 'rejete')
      .slice(-max)
      .map(i => i.text);
  }

  /** Drop the cache so the next read reloads from the vault (post-push). */
  invalidate(): void {
    this.data = null;
  }
}

export function createConclusionsRegistry(vault: VaultManager, embed: EmbedFn | null): ConclusionsRegistry {
  return new ConclusionsRegistry(vault, embed);
}
