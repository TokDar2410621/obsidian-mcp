import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  CalendarProbeService,
  describeChange,
  startLabel,
  startKeyOf,
  startMs,
  type ProbeFetch,
  type ProbeResponse,
} from '@/services/sensors/calendar-probe';
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

const CREDS = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt' };

/**
 * Fake fetch that answers the OAuth token endpoint with a token, and the events
 * endpoint with the given pages (paginated via nextPageToken). Records URLs.
 */
function fakeGoogle(
  pages: unknown[][],
  opts?: { tokenOk?: boolean; eventsStatus?: number },
): ProbeFetch & { urls: string[] } {
  const urls: string[] = [];
  let page = 0;
  const fn = (async (url: string): Promise<ProbeResponse> => {
    urls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const ok = opts?.tokenOk ?? true;
      return {
        ok,
        // Google returns HTTP 400 (not 401) with {"error":"invalid_grant"} for a
        // revoked/expired refresh token. Match that contract faithfully.
        status: ok ? 200 : 400,
        async json() {
          return ok ? { access_token: 'ya29.fake', expires_in: 3599 } : { error: 'invalid_grant' };
        },
        async text() {
          return ok ? '' : '{"error":"invalid_grant"}';
        },
      };
    }
    // events endpoint
    const status = opts?.eventsStatus ?? 200;
    const ok = status >= 200 && status < 300;
    const items = pages[page] ?? [];
    const hasMore = page < pages.length - 1;
    const nextPageToken = hasMore ? `pt${page + 1}` : undefined;
    page += 1;
    return {
      ok,
      status,
      async json() {
        return { items, nextPageToken };
      },
      async text() {
        return ok ? '' : 'error';
      },
    };
  }) as ProbeFetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}

// Fixed clock: 2026-07-27 08:00 UTC.
const NOW = new Date('2026-07-27T08:00:00Z');
const nowFn = () => NOW;

function ev(id: string, startDateTime: string | null, summary?: string, extra?: Record<string, unknown>): unknown {
  const start = startDateTime
    ? /T/.test(startDateTime)
      ? { dateTime: startDateTime }
      : { date: startDateTime }
    : undefined;
  return { id, summary, start, ...extra };
}

// --- pure helpers -------------------------------------------------------------

describe('calendar pure helpers', () => {
  it('labels a timed and an all-day start', () => {
    expect(startLabel('2026-07-30T14:00:00-04:00')).toBe('2026-07-30 à 14:00');
    expect(startLabel('2026-07-30')).toBe('2026-07-30 (journée)');
  });

  it('reads the start key from dateTime or date', () => {
    expect(startKeyOf({ id: 'a', start: { dateTime: '2026-07-30T14:00:00Z' } })).toBe('2026-07-30T14:00:00Z');
    expect(startKeyOf({ id: 'b', start: { date: '2026-07-30' } })).toBe('2026-07-30');
    expect(startKeyOf({ id: 'c' })).toBeNull();
  });

  it('orders by start ms', () => {
    expect(startMs('2026-07-30T14:00:00Z')).toBeGreaterThan(startMs('2026-07-29T14:00:00Z'));
  });

  it('never emits an em-dash in the change line', () => {
    const d = describeChange({ id: 'x', summary: 'Appel A — B', start: { dateTime: '2026-07-30T09:00:00Z' } }, 'new');
    expect(d?.line.includes('—')).toBe(false);
    expect(d?.notifyLine.includes('—')).toBe(false);
  });
});

// --- service ------------------------------------------------------------------

describe('calendar probe service', () => {
  let vault: FakeVault;
  let notify: FakeNotify;

  beforeEach(() => {
    vault = new FakeVault();
    notify = new FakeNotify();
  });

  it('is dormant without credentials (skipped, no reads, no writes)', async () => {
    const probe = new CalendarProbeService({ vault, notify, creds: null });
    const res = await probe.runProbe();
    expect(res.skipped).toBe(true);
    expect(res.events).toBe(0);
    expect(notify.pushes).toHaveLength(0);
    expect(vault.files.size).toBe(0);
  });

  it('surfaces new events into a dated digest and pushes one ntfy', async () => {
    const fetchImpl = fakeGoogle([
      [
        ev('evt_a', '2026-07-30T14:00:00-04:00', 'Style CGI : entretien'),
        ev('evt_b', '2026-08-02', 'Livraison FindItNow'),
      ],
    ]);
    const probe = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl, now: nowFn });
    const res = await probe.runProbe();

    expect(res.skipped).toBe(false);
    expect(res.added).toBe(2);
    expect(res.moved).toBe(0);
    expect(res.files).toEqual(['01-raw/calendar/2026-07-27.md']); // dated by the run day

    const digest = vault.files.get('01-raw/calendar/2026-07-27.md') ?? '';
    expect(digest).toContain('Style CGI : entretien');
    expect(digest).toContain('2026-07-30 à 14:00');
    expect(digest).toContain('Livraison FindItNow');
    expect(digest).toContain('2026-08-02 (journée)');

    expect(notify.pushes).toHaveLength(1);
    expect(notify.pushes[0].title).toMatch(/agenda/i);
    expect(notify.pushes[0].message).toContain('2 nouveau(x) RDV');
    // PII: the event title must NOT reach the ntfy channel (only date/label).
    expect(notify.pushes[0].message).not.toContain('Style CGI');
    expect(notify.pushes[0].message).not.toContain('FindItNow');
    // the token endpoint was called before the events endpoint
    expect(fetchImpl.urls[0]).toContain('oauth2.googleapis.com/token');
    expect(fetchImpl.urls[1]).toContain('/calendars/primary/events');
    expect(fetchImpl.urls[1]).toContain('singleEvents=true');
  });

  it('does not re-ping an all-day event dated today on a second same-day run', async () => {
    // Regression: the API filters by END time, so an all-day event on its own
    // day stays in the window. Reconcile-by-presence keeps it in state; it must
    // not be re-detected as new (the old start-time prune re-flagged it).
    const events = [[ev('evt_today', '2026-07-27', 'Anniversaire')]]; // all-day, today
    const p1 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: fakeGoogle(events), now: nowFn });
    const r1 = await p1.runProbe();
    expect(r1.added).toBe(1);
    notify.pushes = [];

    const p2 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: fakeGoogle(events), now: nowFn });
    const r2 = await p2.runProbe();
    expect(r2.added).toBe(0);
    expect(notify.pushes).toHaveLength(0);
  });

  it('alerts a recurring series only once, not on every occurrence sliding in', async () => {
    const REC = { recurringEventId: 'series_R' };
    // Run 1: two occurrences of the same series already in the window.
    const first = fakeGoogle([[
      ev('occ_1', '2026-07-28T09:00:00Z', 'Standup', REC),
      ev('occ_2', '2026-08-04T09:00:00Z', 'Standup', REC),
    ]]);
    const p1 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: first, now: nowFn });
    const r1 = await p1.runProbe();
    expect(r1.added).toBe(1); // one alert for the whole series
    notify.pushes = [];

    // Run 2: occ_1 has passed, a brand-new occurrence occ_3 slid in (same series).
    const second = fakeGoogle([[
      ev('occ_2', '2026-08-04T09:00:00Z', 'Standup', REC),
      ev('occ_3', '2026-08-11T09:00:00Z', 'Standup', REC),
    ]]);
    const p2 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: second, now: nowFn });
    const r2 = await p2.runProbe();
    expect(r2.added).toBe(0); // the known series does not re-ping
    expect(notify.pushes).toHaveLength(0);
  });

  it('does not notify when the change line is already in today\'s digest (state loss)', async () => {
    const events = [[ev('evt_a', '2026-07-30T14:00:00Z', 'Entretien')]];
    const p1 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: fakeGoogle(events), now: nowFn });
    await p1.runProbe();
    notify.pushes = [];
    // Simulate lost/corrupted state: the digest still holds the line.
    vault.files.delete('08-auto/_calendar-sonde.json');

    const p2 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: fakeGoogle(events), now: nowFn });
    const res = await p2.runProbe();
    expect(res.added).toBe(0); // line already logged -> not fresh -> no ping
    expect(notify.pushes).toHaveLength(0);
  });

  it('detects a reschedule (same id, new start) as moved, not new', async () => {
    const first = fakeGoogle([[ev('evt_a', '2026-07-30T14:00:00Z', 'Entretien')]]);
    const p1 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: first, now: nowFn });
    await p1.runProbe();
    notify.pushes = [];

    const second = fakeGoogle([[ev('evt_a', '2026-07-31T10:00:00Z', 'Entretien')]]); // moved
    const p2 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: second, now: nowFn });
    const res = await p2.runProbe();

    expect(res.added).toBe(0);
    expect(res.moved).toBe(1);
    const digest = vault.files.get('01-raw/calendar/2026-07-27.md') ?? '';
    expect(digest).toContain('RDV déplacé');
    expect(digest).toContain('2026-07-31 à 10:00');
    expect(notify.pushes[0].message).toContain('1 RDV déplacé');
  });

  it('is idempotent: an unchanged event on a second run yields nothing', async () => {
    const events = [[ev('evt_a', '2026-07-30T14:00:00Z', 'Entretien')]];
    const p1 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: fakeGoogle(events), now: nowFn });
    await p1.runProbe();
    notify.pushes = [];
    const p2 = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl: fakeGoogle(events), now: nowFn });
    const res = await p2.runProbe();
    expect(res.added).toBe(0);
    expect(res.moved).toBe(0);
    expect(res.files).toHaveLength(0);
    expect(notify.pushes).toHaveLength(0);
  });

  it('paginates across pages (no truncation)', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ev(`p1_${i}`, '2026-07-30T14:00:00Z', `A${i}`));
    const page2 = Array.from({ length: 2 }, (_, i) => ev(`p2_${i}`, '2026-08-01T14:00:00Z', `B${i}`));
    const fetchImpl = fakeGoogle([page1, page2]);
    const probe = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl, now: nowFn });
    const res = await probe.runProbe();
    expect(res.added).toBe(5);
    // token + 2 event pages = 3 calls; the 2nd events call carries the pageToken
    expect(fetchImpl.urls.filter(u => u.includes('/events')).length).toBe(2);
    expect(fetchImpl.urls.some(u => u.includes('pageToken=pt1'))).toBe(true);
  });

  it('alerts the phone when the refresh token is revoked (invalid_grant)', async () => {
    const fetchImpl = fakeGoogle([[]], { tokenOk: false });
    const probe = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl, now: nowFn });
    const res = await probe.runProbe();
    expect(res.skipped).toBe(false);
    expect(res.error).toBeTruthy();
    expect(notify.pushes).toHaveLength(1);
    expect(notify.pushes[0].title).toMatch(/agenda/i);
    expect(notify.pushes[0].priority).toBe(4);
  });

  it('ignores cancelled events', async () => {
    const fetchImpl = fakeGoogle([
      [ev('evt_c', '2026-07-30T14:00:00Z', 'Annulé', { status: 'cancelled' })],
    ]);
    const probe = new CalendarProbeService({ vault, notify, creds: CREDS, fetchImpl, now: nowFn });
    const res = await probe.runProbe();
    expect(res.added).toBe(0);
    expect(notify.pushes).toHaveLength(0);
  });
});
