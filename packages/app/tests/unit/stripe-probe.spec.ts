import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  StripeProbeService,
  describeEvent,
  classify,
  type ProbeFetch,
  type ProbeResponse,
} from '@/services/sensors/stripe-probe';
import type { VaultManager } from '@/services/vault-manager';
import type { NotifyPusher, Notification } from '@/services/notify/notifier';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

// --- fakes --------------------------------------------------------------------

class FakeVault implements VaultManager {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async moveFile(src: string, dest: string): Promise<void> {
    const content = await this.readFile(src);
    this.files.delete(src);
    this.files.set(dest, content);
  }
  async createDirectory(): Promise<void> {}
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

class FakeNotify implements NotifyPusher {
  pushes: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushes.push(n);
  }
}

/** Single-page fetch: returns one page (has_more false) and records URLs seen. */
function fetchOf(events: unknown[], opts?: { ok?: boolean; status?: number }): ProbeFetch & {
  urls: string[];
} {
  const urls: string[] = [];
  const fn = (async (url: string): Promise<ProbeResponse> => {
    urls.push(url);
    const ok = opts?.ok ?? true;
    return {
      ok,
      status: opts?.status ?? (ok ? 200 : 402),
      async json() {
        return { data: events, has_more: false };
      },
      async text() {
        return ok ? JSON.stringify({ data: events }) : 'error';
      },
    };
  }) as ProbeFetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}

/** Multi-page fetch: yields each page in order, has_more true until the last. */
function pagedFetch(pages: unknown[][]): ProbeFetch & { urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fn = (async (url: string): Promise<ProbeResponse> => {
    urls.push(url);
    const data = pages[i] ?? [];
    const has_more = i < pages.length - 1;
    i += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { data, has_more };
      },
      async text() {
        return '';
      },
    };
  }) as ProbeFetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}

// Fixed clock: 2026-07-20 12:00:00 UTC.
const NOW = new Date('2026-07-20T12:00:00Z');
const nowFn = () => NOW;
const T = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function evt(
  id: string,
  type: string,
  createdIso: string,
  object: Record<string, unknown>,
): unknown {
  return { id, type, created: T(createdIso), data: { object } };
}

// --- pure helpers -------------------------------------------------------------

describe('stripe describeEvent / classify', () => {
  it('classifies the watched types and ignores noise and duplicated twins', () => {
    expect(classify('payment_intent.succeeded')).toBe('money');
    expect(classify('invoice.paid')).toBe('money');
    expect(classify('customer.subscription.created')).toBe('subscription');
    expect(classify('refund.created')).toBe('refund');
    expect(classify('charge.dispute.created')).toBe('dispute');
    // Deliberately NOT watched (twins that double-count one movement).
    expect(classify('charge.refunded')).toBeNull();
    expect(classify('charge.succeeded')).toBeNull();
    expect(classify('customer.created')).toBeNull();
  });

  it('formats a payment line with amount + currency code and the payer', () => {
    const d = describeEvent(
      evt('evt_1', 'payment_intent.succeeded', '2026-07-19T09:12:00Z', {
        amount: 12500,
        currency: 'cad',
        receipt_email: 'client@finditnow.ca',
        description: 'Acompte FindItNow',
      }) as never,
    );
    expect(d?.kind).toBe('money');
    expect(d?.line).toContain('125,00 CAD');
    expect(d?.line).toContain('client@finditnow.ca');
    expect(d?.line).toContain('Acompte FindItNow');
    expect(d?.line.startsWith('- 09:12 · ')).toBe(true);
    // The notify line is PII-free: amount only, no payer / description.
    expect(d?.notifyLine).toBe('paiement reçu 125,00 CAD');
  });

  it('skips an invoice-linked PaymentIntent (invoice.paid owns that money)', () => {
    const d = describeEvent(
      evt('evt_pi', 'payment_intent.succeeded', '2026-07-19T09:12:00Z', {
        amount: 4900,
        currency: 'cad',
        invoice: 'in_123', // this PI settled an invoice
      }) as never,
    );
    expect(d).toBeNull();
  });

  it('uses the Refund object amount for a refund', () => {
    const d = describeEvent(
      evt('evt_r', 'refund.created', '2026-07-19T14:00:00Z', {
        amount: 3000,
        currency: 'cad',
      }) as never,
    );
    expect(d?.kind).toBe('refund');
    expect(d?.line).toContain('30,00 CAD');
  });

  it('handles zero-decimal currencies (no /100)', () => {
    const d = describeEvent(
      evt('evt_jpy', 'payment_intent.succeeded', '2026-07-19T09:12:00Z', {
        amount: 5000,
        currency: 'jpy',
      }) as never,
    );
    expect(d?.line).toContain('5000 JPY');
    expect(d?.line).not.toContain('50,00');
  });

  it('never emits an em-dash in the digest line', () => {
    const d = describeEvent(
      evt('evt_x', 'payment_intent.succeeded', '2026-07-19T09:12:00Z', {
        amount: 100,
        currency: 'usd',
        description: 'Plan A — Plan B',
      }) as never,
    );
    expect(d?.line.includes('—')).toBe(false);
  });
});

// --- service ------------------------------------------------------------------

describe('stripe probe service', () => {
  let vault: FakeVault;
  let notify: FakeNotify;

  beforeEach(() => {
    vault = new FakeVault();
    notify = new FakeNotify();
  });

  it('is dormant without an API key (skipped, no reads, no writes)', async () => {
    const probe = new StripeProbeService({ vault, notify, apiKey: null });
    const res = await probe.runProbe();
    expect(res.skipped).toBe(true);
    expect(res.events).toBe(0);
    expect(notify.pushes).toHaveLength(0);
    expect(vault.files.size).toBe(0);
  });

  it('writes a dated digest, counts money in, and pushes one PII-free ntfy', async () => {
    const fetchImpl = fetchOf([
      evt('evt_pay', 'payment_intent.succeeded', '2026-07-19T09:12:00Z', {
        amount: 12500,
        currency: 'cad',
        receipt_email: 'client@finditnow.ca',
        description: 'Acompte FindItNow',
      }),
      evt('evt_sub', 'customer.subscription.created', '2026-07-19T10:00:00Z', {}),
      evt('evt_noise', 'customer.created', '2026-07-19T10:05:00Z', {}),
    ]);
    const probe = new StripeProbeService({ vault, notify, apiKey: 'rk_test_x', fetchImpl, now: nowFn });
    const res = await probe.runProbe();

    expect(res.skipped).toBe(false);
    expect(res.moneyIn).toBe(1);
    expect(res.subscriptions).toBe(1);
    expect(res.events).toBe(2); // 1 paiement + 1 abonnement (customer.created is noise)
    expect(res.files).toEqual(['01-raw/stripe/2026-07-19.md']);

    const digest = vault.files.get('01-raw/stripe/2026-07-19.md') ?? '';
    expect(digest).toContain('125,00 CAD');
    expect(digest).toContain('client@finditnow.ca'); // payer email stays in the private vault
    expect(digest).toContain('nouvel abonnement');
    expect(digest).not.toContain('customer.created');

    expect(notify.pushes).toHaveLength(1);
    expect(notify.pushes[0].title).toMatch(/argent/i);
    expect(notify.pushes[0].message).toContain('paiement');
    // PII must NOT leak to the ntfy channel.
    expect(notify.pushes[0].message).not.toContain('@');
    expect(notify.pushes[0].message).not.toContain('Acompte');

    // the fetch URL carries the type filter and the created floor
    expect(fetchImpl.urls[0]).toContain('types%5B%5D=payment_intent.succeeded');
    expect(fetchImpl.urls[0]).toContain('created%5Bgte%5D=');
  });

  it('counts a subscription sale ONCE despite the invoice.paid + payment_intent twins', async () => {
    // A real subscription sale fires all three; only invoice.paid should count as money.
    const fetchImpl = fetchOf([
      evt('evt_sub', 'customer.subscription.created', '2026-07-19T10:00:00Z', {}),
      evt('evt_inv', 'invoice.paid', '2026-07-19T10:00:01Z', {
        amount_paid: 4900,
        currency: 'cad',
        customer_email: 'sub@client.ca',
      }),
      evt('evt_pi', 'payment_intent.succeeded', '2026-07-19T10:00:02Z', {
        amount: 4900,
        currency: 'cad',
        invoice: 'in_123', // the twin: must be skipped
      }),
    ]);
    const probe = new StripeProbeService({ vault, notify, apiKey: 'rk_test_x', fetchImpl, now: nowFn });
    const res = await probe.runProbe();

    expect(res.moneyIn).toBe(1); // NOT 2
    expect(res.subscriptions).toBe(1);
    const digest = vault.files.get('01-raw/stripe/2026-07-19.md') ?? '';
    // exactly one "paiement reçu" line
    expect((digest.match(/paiement reçu/g) || []).length).toBe(1);
    expect(notify.pushes[0].message).toContain('1 paiement(s)');
  });

  it('counts a refund ONCE (only refund.created is watched, not charge.refunded)', async () => {
    const fetchImpl = fetchOf([
      evt('evt_chg', 'charge.refunded', '2026-07-19T14:00:00Z', {
        amount: 10000,
        amount_refunded: 3000,
        currency: 'cad',
      }),
      evt('evt_ref', 'refund.created', '2026-07-19T14:00:01Z', {
        amount: 3000,
        currency: 'cad',
      }),
    ]);
    const probe = new StripeProbeService({ vault, notify, apiKey: 'rk_test_x', fetchImpl, now: nowFn });
    const res = await probe.runProbe();
    expect(res.refunds).toBe(1); // NOT 2
    const digest = vault.files.get('01-raw/stripe/2026-07-19.md') ?? '';
    const refundLines = digest.split('\n').filter(l => l.startsWith('- ') && l.includes('remboursement'));
    expect(refundLines).toHaveLength(1);
    expect(digest).toContain('30,00 CAD');
  });

  it('paginates a cold-start backfill of more than one page (no silent drop)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      evt(`evt_a${i}`, 'payment_intent.succeeded', '2026-07-19T09:00:00Z', {
        amount: 1000,
        currency: 'cad',
      }),
    );
    const page2 = Array.from({ length: 50 }, (_, i) =>
      evt(`evt_b${i}`, 'payment_intent.succeeded', '2026-07-18T09:00:00Z', {
        amount: 1000,
        currency: 'cad',
      }),
    );
    const fetchImpl = pagedFetch([page1, page2]);
    const probe = new StripeProbeService({ vault, notify, apiKey: 'rk_test_x', fetchImpl, now: nowFn });
    const res = await probe.runProbe();

    expect(res.moneyIn).toBe(150); // all 150, none dropped
    expect(fetchImpl.urls).toHaveLength(2); // two pages fetched
    expect(fetchImpl.urls[1]).toContain('starting_after='); // cursor on the 2nd page
    // spread across the two days
    expect(vault.files.get('01-raw/stripe/2026-07-19.md')).toBeTruthy();
    expect(vault.files.get('01-raw/stripe/2026-07-18.md')).toBeTruthy();
  });

  it('is idempotent: a second run adds nothing and sends no push', async () => {
    const events = [
      evt('evt_pay', 'payment_intent.succeeded', '2026-07-19T09:12:00Z', {
        amount: 5000,
        currency: 'cad',
      }),
    ];
    const probe1 = new StripeProbeService({
      vault,
      notify,
      apiKey: 'rk_test_x',
      fetchImpl: fetchOf(events),
      now: nowFn,
    });
    await probe1.runProbe();
    notify.pushes = [];

    // Same event returned again (overlap re-scan): must be deduped by id.
    const probe2 = new StripeProbeService({
      vault,
      notify,
      apiKey: 'rk_test_x',
      fetchImpl: fetchOf(events),
      now: nowFn,
    });
    const res2 = await probe2.runProbe();
    expect(res2.moneyIn).toBe(0);
    expect(res2.files).toHaveLength(0);
    expect(notify.pushes).toHaveLength(0);
  });

  it('raises a higher-priority alert on a dispute', async () => {
    const probe = new StripeProbeService({
      vault,
      notify,
      apiKey: 'rk_test_x',
      fetchImpl: fetchOf([
        evt('evt_disp', 'charge.dispute.created', '2026-07-19T11:00:00Z', {
          amount: 8000,
          currency: 'cad',
        }),
      ]),
      now: nowFn,
    });
    const res = await probe.runProbe();
    expect(res.disputes).toBe(1);
    expect(notify.pushes).toHaveLength(1);
    expect(notify.pushes[0].title).toMatch(/litige/i);
    expect(notify.pushes[0].priority).toBe(4);
  });

  it('swallows an API error and alerts the phone on an auth/permission failure', async () => {
    const probe = new StripeProbeService({
      vault,
      notify,
      apiKey: 'rk_test_x',
      fetchImpl: fetchOf([], { ok: false, status: 403 }),
      now: nowFn,
    });
    const res = await probe.runProbe();
    expect(res.skipped).toBe(false);
    expect(res.error).toBeTruthy();
    // a mis-scoped key must not fail silently
    expect(notify.pushes).toHaveLength(1);
    expect(notify.pushes[0].title).toMatch(/clé/i);
  });
});
