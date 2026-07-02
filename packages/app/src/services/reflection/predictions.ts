import type { VaultManager } from '@/services/vault-manager';
import { logger } from '@/utils/logger';

/**
 * The prediction book — learning from prediction error.
 *
 * The mind places dated, verifiable bets on reality ("if X ships, expect Y
 * within a week"). At each cycle, due bets are checked against the vault and
 * resolved; the *gap* between expectation and outcome becomes a lesson (the
 * strongest learning signal a brain has). Stored in the vault so Darius can
 * read and correct it: `08-auto/_predictions.json` (canonical, quarantine).
 */

export interface Prediction {
  id: string;
  statement: string; // the verifiable bet
  expectedBy: string; // YYYY-MM-DD
  confidence: number; // 0..1
  basis: string; // which thread / reasoning it came from
  madeOn: string;
}

export interface ResolvedPrediction extends Prediction {
  status: 'confirmed' | 'refuted' | 'expired';
  outcome: string;
  lesson: string;
  resolvedOn: string;
}

export interface PredictionBook {
  open: Prediction[];
  resolved: ResolvedPrediction[];
}

const BOOK_FILE = '08-auto/_predictions.json';
const MAX_OPEN = 8;
const MAX_RESOLVED = 20;
const EXPIRE_AFTER_DAYS = 14; // overdue + unverifiable this long -> expired, ask Darius

/**
 * Load the book. `ok:false` means the file exists but is unreadable — in that
 * case the caller must NOT save (never overwrite a recoverable book).
 */
export async function loadBook(vault: VaultManager): Promise<{ book: PredictionBook; ok: boolean }> {
  const empty: PredictionBook = { open: [], resolved: [] };
  try {
    if (!(await vault.fileExists(BOOK_FILE))) return { book: empty, ok: true };
    const parsed = JSON.parse(await vault.readFile(BOOK_FILE)) as Partial<PredictionBook>;
    return {
      book: {
        open: (Array.isArray(parsed.open) ? parsed.open : []).filter(valid).slice(0, MAX_OPEN),
        resolved: (Array.isArray(parsed.resolved) ? parsed.resolved : []).slice(-MAX_RESOLVED),
      },
      ok: true,
    };
  } catch (error) {
    logger.warn('Prediction book unreadable — predictions skipped this cycle', {
      error: String(error),
    });
    return { book: empty, ok: false };
  }
}

export async function saveBook(vault: VaultManager, book: PredictionBook): Promise<void> {
  book.open = book.open.slice(0, MAX_OPEN);
  book.resolved = book.resolved.slice(-MAX_RESOLVED);
  await vault.writeFile(BOOK_FILE, JSON.stringify(book, null, 2));
}

/** Bets whose deadline has passed. */
export function duePredictions(book: PredictionBook, today: string): Prediction[] {
  return book.open.filter(p => p.expectedBy <= today);
}

/** True when the overdue bet has waited long enough to be declared expired. */
export function isExpired(p: Prediction, today: string): boolean {
  const due = Date.parse(p.expectedBy);
  const now = Date.parse(today);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return false;
  return (now - due) / 86_400_000 > EXPIRE_AFTER_DAYS;
}

/** Add a new bet if the statement is sound and the book has room. */
export function addPrediction(
  book: PredictionBook,
  p: { statement?: unknown; expectedBy?: unknown; confidence?: unknown },
  basis: string,
  today: string,
): Prediction | null {
  const statement = String(p.statement ?? '').trim();
  const expectedBy = String(p.expectedBy ?? '').trim();
  if (!statement || !/^\d{4}-\d{2}-\d{2}$/.test(expectedBy)) return null;
  if (expectedBy <= today) return null; // a bet must be about the future
  if (book.open.length >= MAX_OPEN) return null;
  if (book.open.some(o => o.statement.toLowerCase() === statement.toLowerCase())) return null;
  // Collision-proof id: open.length shrinks when bets resolve, so derive the
  // suffix from the max already used today (across open AND resolved).
  const prefix = `p-${today}-`;
  const suffixes = [...book.open, ...book.resolved]
    .map(x => x.id)
    .filter(id => id.startsWith(prefix))
    .map(id => Number(id.slice(prefix.length)))
    .filter(Number.isFinite);
  const bet: Prediction = {
    id: `${prefix}${(suffixes.length ? Math.max(...suffixes) : 0) + 1}`,
    statement,
    expectedBy,
    confidence: clamp01(p.confidence),
    basis: basis.slice(0, 200),
    madeOn: today,
  };
  book.open.push(bet);
  return bet;
}

/** Move an open bet to resolved with its outcome and lesson. */
export function resolvePrediction(
  book: PredictionBook,
  id: string,
  resolution: { status: ResolvedPrediction['status']; outcome: string; lesson: string },
  today: string,
): ResolvedPrediction | null {
  const idx = book.open.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const [p] = book.open.splice(idx, 1);
  const resolved: ResolvedPrediction = {
    ...p,
    status: resolution.status,
    outcome: resolution.outcome.slice(0, 400),
    lesson: resolution.lesson.slice(0, 400),
    resolvedOn: today,
  };
  book.resolved.push(resolved);
  return resolved;
}

function valid(p: unknown): p is Prediction {
  const o = p as Partial<Prediction>;
  return Boolean(o && typeof o.id === 'string' && typeof o.statement === 'string' && o.expectedBy);
}

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}
