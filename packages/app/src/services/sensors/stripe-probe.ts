import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import { logger } from '@/utils/logger';

/**
 * Stripe sensor probe. One of the cerveau's eyes on a compartment where money
 * actually moves: it answers "l'acompte est-il arrive ? un abonnement a-t-il
 * demarre ? un remboursement, un litige ?" without Darius having to open the
 * dashboard.
 *
 * Design (couche sensorielle, 2026-07-26): read-only, notable-only. It pulls
 * the Stripe event log (retained 30 days), keeps ONLY the events that carry
 * meaning for a solo (money in, new subscription, refund, dispute), writes a
 * dated digest to `01-raw/stripe/AAAA-MM-JJ.md`, and pushes ONE ntfy per run
 * that has news. Every raw transaction is NOT logged: the filter is the point.
 *
 * Autonomous, like the PC2 workers: it needs no MCP connector, just a Stripe
 * RESTRICTED key with read access, in `STRIPE_API_KEY`. Absent = the probe
 * sleeps cleanly (returns skipped), so the code ships before the key exists.
 *
 * The restricted key MUST grant Read on every resource behind a watched event,
 * or `GET /v1/events` silently omits that resource's events (a missing Disputes
 * scope would hide a dispute deadline). Required Read scopes:
 *   PaymentIntents, Invoices, Customer subscriptions, Charges, Refunds, Disputes.
 * The key is read from the env only, never logged, never written to the vault.
 */

const RAW_DIR = '01-raw/stripe';
const STATE_FILE = '08-auto/_stripe-sonde.json';
const STRIPE_API = 'https://api.stripe.com/v1/events';

/** How far back to look on a cold start (no prior state), in days. */
const CATCHUP_DAYS = 30; // Stripe retains events ~30 days; grab the full window once.
/** Overlap re-scanned each run so a boundary event is never skipped (dedup by id). */
const OVERLAP_SECONDS = 3600;
/** Seen-event ids kept in state (immutable evt ids; bounds the file size). */
const MAX_SEEN = 500;
/** Events fetched per page (Stripe max is 100). */
const PAGE_LIMIT = 100;
/** Pagination guard: 20 pages * 100 = 2000 events per run, far above a solo's volume. */
const MAX_PAGES = 20;

/**
 * Stripe event types the probe watches. NOTE on overlap (learned the hard way
 * in review, 2026-07-26): several Stripe events fire for ONE money movement.
 *  - A subscription/invoice payment fires BOTH `invoice.paid` AND
 *    `payment_intent.succeeded`. We keep both in the fetch but SKIP the
 *    invoice-linked payment_intent in describeEvent (invoice.paid owns it), so
 *    only genuine one-off PaymentIntents (no invoice) count as money.
 *  - A refund fires BOTH `charge.refunded` AND `refund.created`. We watch ONLY
 *    `refund.created`: its `amount` is the exact per-refund figure, whereas a
 *    Charge's `amount_refunded` is cumulative across refunds.
 */
const MONEY_IN_TYPES = new Set(['payment_intent.succeeded', 'invoice.paid']);
const SUBSCRIPTION_TYPES = new Set(['customer.subscription.created']);
const REFUND_TYPES = new Set(['refund.created']);
const DISPUTE_TYPES = new Set(['charge.dispute.created']);
const WATCHED_TYPES = [
  ...MONEY_IN_TYPES,
  ...SUBSCRIPTION_TYPES,
  ...REFUND_TYPES,
  ...DISPUTE_TYPES,
];

/** Zero-decimal currencies: their Stripe amount is already the whole unit. */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx',
  'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

// --- injectable fetch (real fetch in prod, a fake in tests) -------------------

export interface ProbeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<ProbeResponse>;

// --- shapes -------------------------------------------------------------------

export interface StripeProbeDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  /** Stripe restricted read key. Defaults to STRIPE_API_KEY. Absent = dormant. */
  apiKey?: string | null;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: ProbeFetch;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => Date;
}

export interface StripeProbeResult {
  /** True when no key is set: the probe did nothing on purpose. */
  skipped: boolean;
  /** New notable events processed this run (money + subs + refunds + disputes). */
  events: number;
  /** Money-in events among them. */
  moneyIn: number;
  /** New-subscription events among them. */
  subscriptions: number;
  /** Refund events among them. */
  refunds: number;
  /** Dispute events among them. */
  disputes: number;
  /** Digest files written/updated this run. */
  files: string[];
  /** Set when a network/API error was swallowed (a sensor never crashes boot). */
  error?: string;
}

interface ProbeState {
  version: 1;
  /** Unix seconds of the newest event seen; the next fetch floor. */
  lastCreated: number;
  /** Event ids already digested, id -> created (unix seconds), capped to MAX_SEEN. */
  seen: Record<string, number>;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

// --- helpers ------------------------------------------------------------------

/** Never emit an em-dash (rule of the cerveau; the git hook blocks it too). */
function sansEmDash(text: string): string {
  return text.replace(/ — /g, ' : ').replace(/—/g, ' : ');
}

/** Stripe amounts are in the currency's minor unit, except zero-decimal ones. */
function formatAmount(amount: unknown, currency: unknown): string {
  const raw = typeof amount === 'number' ? amount : 0;
  const cur = typeof currency === 'string' ? currency.toUpperCase() : '';
  const value = ZERO_DECIMAL.has(cur.toLowerCase())
    ? String(raw)
    : (raw / 100).toFixed(2).replace('.', ',');
  return cur ? `${value} ${cur}` : value;
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export type NotableKind = 'money' | 'subscription' | 'refund' | 'dispute';

export function classify(type: string): NotableKind | null {
  if (MONEY_IN_TYPES.has(type)) return 'money';
  if (SUBSCRIPTION_TYPES.has(type)) return 'subscription';
  if (REFUND_TYPES.has(type)) return 'refund';
  if (DISPUTE_TYPES.has(type)) return 'dispute';
  return null;
}

export interface DescribedEvent {
  kind: NotableKind;
  /** Full line for the private vault digest (may carry payer email). */
  line: string;
  /** PII-free line for the ntfy push (label + amount only, no payer/description). */
  notifyLine: string;
}

/**
 * Build the digest and notification lines from a Stripe event. Pure, tested
 * directly. Returns null for events that are not notable OR that duplicate a
 * money movement already counted by their twin (an invoice-linked PaymentIntent
 * is owned by invoice.paid).
 */
export function describeEvent(evt: StripeEvent): DescribedEvent | null {
  const kind = classify(evt.type);
  if (!kind) return null;
  const obj = evt.data?.object ?? {};

  // A PaymentIntent created to pay an invoice carries a non-empty `invoice`
  // field; invoice.paid already counts that money, so skip the twin to avoid
  // double-counting every subscription/invoice payment.
  if (evt.type === 'payment_intent.succeeded' && firstString(obj['invoice'])) {
    return null;
  }

  const hm = new Date(evt.created * 1000).toISOString().slice(11, 16);
  const who = firstString(
    obj['customer_email'],
    obj['receipt_email'],
    (obj['billing_details'] as Record<string, unknown> | undefined)?.['email'],
    obj['customer'],
  );
  const why = firstString(obj['description'], obj['statement_descriptor']);
  const amount = formatAmount(
    obj['amount'] ?? obj['amount_paid'] ?? obj['amount_received'],
    obj['currency'],
  );
  let label: string;
  switch (kind) {
    case 'money':
      label = `paiement reçu ${amount}`;
      break;
    case 'subscription':
      label = 'nouvel abonnement';
      break;
    case 'refund':
      label = `remboursement ${amount}`;
      break;
    case 'dispute':
      label = `LITIGE ouvert ${amount}`;
      break;
  }
  const tail = [who, why].filter(Boolean).join(' : ');
  return {
    kind,
    line: sansEmDash(`- ${hm} · ${label}${tail ? ` · ${tail}` : ''}`),
    notifyLine: sansEmDash(label),
  };
}

// --- service ------------------------------------------------------------------

export class StripeProbeService {
  private readonly fetchImpl: ProbeFetch;
  private readonly now: () => Date;
  private readonly apiKey: string | null;

  constructor(private readonly deps: StripeProbeDeps) {
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as ProbeFetch);
    this.now = deps.now ?? (() => new Date());
    // An explicitly-provided apiKey (even null) wins over the env: injection
    // must be able to force the probe dormant in tests. Only a fully OMITTED
    // key falls back to STRIPE_API_KEY.
    this.apiKey = 'apiKey' in deps ? (deps.apiKey ?? null) : (process.env.STRIPE_API_KEY ?? null);
  }

  async runProbe(): Promise<StripeProbeResult> {
    const empty: StripeProbeResult = {
      skipped: true,
      events: 0,
      moneyIn: 0,
      subscriptions: 0,
      refunds: 0,
      disputes: 0,
      files: [],
    };
    if (!this.apiKey) {
      logger.info('Stripe probe dormant (STRIPE_API_KEY absent)');
      return empty;
    }

    const state = await this.loadState();
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const floor = state.lastCreated
      ? Math.max(0, state.lastCreated - OVERLAP_SECONDS)
      : nowSec - CATCHUP_DAYS * 86400;

    let events: StripeEvent[];
    try {
      events = await this.fetchEvents(floor);
    } catch (error) {
      const msg = String(error).slice(0, 200);
      logger.warn('Stripe probe fetch failed', { error: msg });
      // A mis-scoped or revoked key must not fail silently: reach the phone.
      if (/\b(401|403)\b|permission|Invalid API Key|authentication/i.test(msg) && this.deps.notify) {
        await this.deps.notify.push({
          title: 'Stripe : clé à corriger',
          message: sansEmDash('La sonde Stripe ne peut pas lire : clé restreinte manquante ou mal cadrée.'),
          priority: 4,
          tags: ['warning', 'key'],
        });
      }
      return { ...empty, skipped: false, error: msg };
    }

    // Chronological (Stripe returns newest first) and only genuinely new ids.
    const fresh = events
      .filter(e => e && e.id && state.seen[e.id] === undefined)
      .sort((a, b) => a.created - b.created);

    const byDay = new Map<string, string[]>();
    let moneyIn = 0;
    let subscriptions = 0;
    let refunds = 0;
    let disputes = 0;
    const notifyLines: string[] = [];

    for (const evt of fresh) {
      const described = describeEvent(evt);
      state.seen[evt.id] = evt.created;
      state.lastCreated = Math.max(state.lastCreated, evt.created);
      if (!described) continue;
      const day = new Date(evt.created * 1000).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(described.line);
      notifyLines.push(described.notifyLine);
      if (described.kind === 'money') moneyIn += 1;
      else if (described.kind === 'subscription') subscriptions += 1;
      else if (described.kind === 'refund') refunds += 1;
      else if (described.kind === 'dispute') disputes += 1;
    }

    const files: string[] = [];
    for (const [day, lines] of byDay) {
      const written = await this.appendDigest(day, lines);
      if (written) files.push(written);
    }

    this.trimSeen(state);
    await this.saveState(state);

    const notable = moneyIn + subscriptions + refunds + disputes;
    if (notable > 0 && this.deps.notify) {
      await this.deps.notify.push(
        this.buildNotification(moneyIn, subscriptions, refunds, disputes, notifyLines),
      );
    }

    return { skipped: false, events: notable, moneyIn, subscriptions, refunds, disputes, files };
  }

  /**
   * Fetch all watched events at or after `floorUnix`, paginating until Stripe
   * says there are no more. Without this, a cold-start 30-day back-fill of more
   * than 100 notable events would silently drop the oldest for good (the state
   * floor would march past them).
   */
  private async fetchEvents(floorUnix: number): Promise<StripeEvent[]> {
    const all: StripeEvent[] = [];
    let startingAfter: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_LIMIT));
      params.set('created[gte]', String(floorUnix));
      for (const t of WATCHED_TYPES) params.append('types[]', t);
      if (startingAfter) params.set('starting_after', startingAfter);
      const url = `${STRIPE_API}?${params.toString()}`;

      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'Stripe-Version': '2024-06-20',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Stripe API ${res.status}: ${body.slice(0, 120)}`);
      }
      const payload = (await res.json()) as { data?: StripeEvent[]; has_more?: boolean };
      const data = Array.isArray(payload?.data) ? payload.data : [];
      all.push(...data);
      if (!payload?.has_more || data.length === 0) return all;
      startingAfter = data[data.length - 1]?.id ?? null;
      if (!startingAfter) return all;
    }
    logger.warn('Stripe probe hit MAX_PAGES; some older events may remain unfetched', {
      pages: MAX_PAGES,
    });
    return all;
  }

  private buildNotification(
    moneyIn: number,
    subscriptions: number,
    refunds: number,
    disputes: number,
    notifyLines: string[],
  ) {
    const bits: string[] = [];
    if (moneyIn > 0) bits.push(`${moneyIn} paiement(s) reçu(s)`);
    if (subscriptions > 0) bits.push(`${subscriptions} nouvel(s) abonnement(s)`);
    if (refunds > 0) bits.push(`${refunds} remboursement(s)`);
    if (disputes > 0) bits.push(`${disputes} litige(s)`);
    const title = disputes > 0 ? 'Stripe : litige à voir' : 'Stripe : argent reçu';
    // PII-free: notifyLines are label + amount only (payer email stays in the
    // private vault digest, never on the ntfy channel).
    const detail = notifyLines.slice(0, 3).join(' ; ');
    const message = sansEmDash(`${bits.join(', ')}${detail ? `. ${detail}` : ''}`);
    return {
      title,
      message,
      priority: disputes > 0 ? 4 : 3,
      tags: disputes > 0 ? ['warning', 'money_with_wings'] : ['moneybag'],
      click: 'https://dashboard.stripe.com/payments',
    };
  }

  private async appendDigest(day: string, lines: string[]): Promise<string | null> {
    const rel = `${RAW_DIR}/${day}.md`;
    let base: string;
    try {
      base = (await this.deps.vault.readFile(rel)).replace(/\n+$/, '');
    } catch {
      base = [
        '---',
        'type: raw',
        'tags: [stripe, argent]',
        `created: ${day}`,
        '---',
        '',
        `# Stripe le ${day}`,
        '',
        '> Ce qui a bougé côté argent (paiements, abonnements, remboursements, litiges),',
        '> filtré sur le notable et rendu visible au cerveau. Lecture seule.',
        '',
      ].join('\n');
    }
    // Whole-line dedup (a substring test would drop a distinct shorter line that
    // happens to be a prefix of an existing longer one).
    const existing = new Set(base.split('\n'));
    const fresh = lines.filter(l => !existing.has(l));
    if (fresh.length === 0) return null;
    await this.deps.vault.writeFile(rel, `${base}\n${fresh.join('\n')}\n`);
    return rel;
  }

  private async loadState(): Promise<ProbeState> {
    const empty: ProbeState = { version: 1, lastCreated: 0, seen: {} };
    try {
      const raw = await this.deps.vault.readFile(STATE_FILE);
      const parsed = JSON.parse(raw) as Partial<ProbeState>;
      return {
        version: 1,
        lastCreated: typeof parsed.lastCreated === 'number' ? parsed.lastCreated : 0,
        seen: parsed.seen ?? {},
      };
    } catch {
      return empty;
    }
  }

  private trimSeen(state: ProbeState): void {
    const ids = Object.keys(state.seen);
    if (ids.length <= MAX_SEEN) return;
    // Keep the newest MAX_SEEN by created time (a proper numeric total order),
    // but never evict an id still inside the overlap window: it would be
    // re-fetched next run, re-counted, and re-notified.
    const guard = state.lastCreated - OVERLAP_SECONDS;
    const sorted = ids.sort((a, b) => state.seen[b] - state.seen[a]);
    sorted.slice(MAX_SEEN).forEach(id => {
      if (state.seen[id] < guard) delete state.seen[id];
    });
  }

  private async saveState(state: ProbeState): Promise<void> {
    await writeStateFile(this.deps.vault, STATE_FILE, JSON.stringify(state, null, 2));
  }
}
