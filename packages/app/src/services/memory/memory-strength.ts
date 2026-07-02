import fs from 'fs';
import path from 'path';
import { logger } from '@/utils/logger';

/**
 * Memory strength — the forgetting curve applied to the vault.
 *
 * Every note recalled by ask-cerveau gets its trace strengthened (retrieval
 * practice); time decays every trace (Ebbinghaus); notes recalled together
 * accumulate a Hebbian co-activation count. The store lives on the data volume
 * (`${RAG_INDEX_DIR}/cerveau-memory.json`), NOT in the vault: it is
 * high-frequency derived signal, not content. The daily reflection cycle reads
 * it to render `08-auto/_memoire.md` and to propose archiving faded episodic
 * notes (propose-only — this store never touches notes).
 */

interface FileTrace {
  s: number; // strength (0..MAX_STRENGTH)
  r: number; // recall count
  last: string; // last recall date (YYYY-MM-DD)
  born: string; // first seen date
}

interface MemoryData {
  files: Record<string, FileTrace>;
  pairs: Record<string, number>; // "a||b" (sorted) -> co-recall count (decays too)
  decayedOn: string;
  born: string; // when this store started observing (gates archive proposals)
}

const RECALL_BOOST = 0.5;
const MAX_STRENGTH = 2;
const EPISODIC_DAILY_DECAY = 0.977; // half-life ≈ 30 days
const SEMANTIC_DAILY_DECAY = 0.998; // half-life ≈ 1 year (distilled knowledge endures)
const PAIR_DAILY_DECAY = 0.99; // Hebbian links fade too, so new ones can emerge
const PRUNE_BELOW = 0.02;
const MAX_FILES = 5000;
const MAX_PAIRS = 200;
const MAX_RECALL_FILES = 8; // per ask — bounds pair explosion
const FLUSH_MS = 5000; // debounce: losing a few seconds of signal on crash is fine

export class MemoryStrengthStore {
  private data: MemoryData;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* save() will warn if the dir is truly unwritable */
    }
    this.data = this.load();
    if (!this.data.born) this.data.born = isoDay();
  }

  /** Strengthen the traces of notes just cited in an answer (+ Hebbian pairs). */
  recordRecall(files: string[]): void {
    const today = isoDay();
    const unique = [...new Set(files.filter(f => typeof f === 'string' && f.trim()))].slice(
      0,
      MAX_RECALL_FILES,
    );
    if (unique.length === 0) return;
    for (const f of unique) {
      const t = this.data.files[f] ?? { s: 1, r: 0, last: today, born: today };
      t.s = round3(Math.min(MAX_STRENGTH, t.s + RECALL_BOOST));
      t.r += 1;
      t.last = today;
      this.data.files[f] = t;
    }
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = [unique[i], unique[j]].sort().join('||');
        this.data.pairs[key] = (this.data.pairs[key] ?? 0) + 1;
      }
    }
    this.scheduleSave();
  }

  /**
   * Apply time decay once per day (idempotent within a day). `isSemantic`
   * decides which half-life a file gets: distilled knowledge fades slowly,
   * episodes fade fast. Pairs decay too, so the Hebbian layer stays alive.
   */
  decay(isSemantic: (file: string) => boolean): void {
    const today = isoDay();
    if (!this.data.decayedOn) {
      // Seed the clock on first run — without this the organ never decays.
      this.data.decayedOn = today;
      this.dirty = true;
      this.flush();
      return;
    }
    const days = daysBetween(this.data.decayedOn, today);
    if (days <= 0) return;
    for (const [f, t] of Object.entries(this.data.files)) {
      const rate = isSemantic(f) ? SEMANTIC_DAILY_DECAY : EPISODIC_DAILY_DECAY;
      t.s = round3(t.s * Math.pow(rate, days));
      if (t.s < PRUNE_BELOW) delete this.data.files[f];
    }
    const pairFactor = Math.pow(PAIR_DAILY_DECAY, days);
    for (const [k, c] of Object.entries(this.data.pairs)) {
      const v = c * pairFactor;
      if (v < 1) delete this.data.pairs[k];
      else this.data.pairs[k] = round3(v);
    }
    this.bound();
    this.data.decayedOn = today;
    this.dirty = true;
    this.flush();
  }

  /** Days since the store started observing (archive proposals wait for this). */
  ageDays(today: string): number {
    return daysBetween(this.data.born, today);
  }

  /** Current strength of a note's trace (0 = never recalled or fully faded). */
  strengthOf(file: string): number {
    return this.data.files[file]?.s ?? 0;
  }

  /** Strongest memories (what the cerveau keeps reaching for). */
  top(n: number): Array<{ file: string; s: number; r: number }> {
    return Object.entries(this.data.files)
      .map(([file, t]) => ({ file, s: t.s, r: t.r }))
      .sort((a, b) => b.s - a.s || b.r - a.r)
      .slice(0, n);
  }

  /** Hottest Hebbian pairs (notes that keep firing together). */
  hotPairs(n: number): Array<{ a: string; b: string; count: number }> {
    return Object.entries(this.data.pairs)
      .map(([key, count]) => {
        const [a, b] = key.split('||');
        return { a, b, count };
      })
      .filter(p => p.a && p.b && p.count >= 2)
      .sort((x, y) => y.count - x.count)
      .slice(0, n);
  }

  // --- persistence ---------------------------------------------------------

  private load(): MemoryData {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<MemoryData>;
        return {
          files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
          pairs: parsed.pairs && typeof parsed.pairs === 'object' ? parsed.pairs : {},
          decayedOn: typeof parsed.decayedOn === 'string' ? parsed.decayedOn : '',
          born: typeof parsed.born === 'string' ? parsed.born : '',
        };
      }
    } catch (error) {
      // Preserve the corrupt file instead of letting the next save overwrite it.
      logger.warn('Memory store unreadable — kept as .corrupt, starting fresh', {
        error: String(error),
      });
      try {
        fs.renameSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* ignore */
      }
    }
    return { files: {}, pairs: {}, decayedOn: '', born: '' };
  }

  /** Debounced save: recordRecall runs on the ask-cerveau hot path. */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Atomic write (tmp + rename): a crash mid-write can't corrupt the store. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.warn('Memory store save failed (signal lost, not fatal)', { error: String(error) });
    }
  }

  private bound(): void {
    const files = Object.entries(this.data.files);
    if (files.length > MAX_FILES) {
      files.sort((a, b) => b[1].s - a[1].s);
      this.data.files = Object.fromEntries(files.slice(0, MAX_FILES));
    }
    const pairs = Object.entries(this.data.pairs);
    if (pairs.length > MAX_PAIRS) {
      pairs.sort((a, b) => b[1] - a[1]);
      this.data.pairs = Object.fromEntries(pairs.slice(0, MAX_PAIRS));
    }
  }
}

/** Build the store on the persistent data volume (same home as the RAG index). */
export function createMemoryStrength(): MemoryStrengthStore {
  const dir = process.env.RAG_INDEX_DIR || '.rag-index';
  return new MemoryStrengthStore(path.join(dir, 'cerveau-memory.json'));
}

// --- helpers -----------------------------------------------------------------

function isoDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
