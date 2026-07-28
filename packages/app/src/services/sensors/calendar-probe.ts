import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import { logger } from '@/utils/logger';

/**
 * Google Calendar sensor probe. One of the cerveau's eyes on time: it answers
 * "quel RDV arrive ? qu'est-ce qui vient d'atterrir sur mon agenda ?" without
 * Darius having to open Google Calendar.
 *
 * Design (couche sensorielle, 2026-07-26): read-only, change-only. Each run it
 * lists the upcoming events (Calendar API expands recurring events server-side,
 * the reason we use the API over a raw iCal feed), compares them to what it saw
 * before, and keeps ONLY the NEW and the RESCHEDULED ones into a dated digest
 * `01-raw/calendar/AAAA-MM-JJ.md`, plus ONE ntfy per run that has news. The
 * brief and war-room read the digest for "les RDV connus".
 *
 * Autonomous, like the PC2 workers: no MCP connector, just an OAuth client and
 * a long-lived refresh token (chosen by Darius, 2026-07-27) in the env. Absent
 * = the probe sleeps cleanly, so the code ships before the credential exists.
 *
 * Required env (read only, never logged, never written to the vault):
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 *   GOOGLE_CALENDAR_ID   optional, defaults to 'primary'
 *
 * Change detection reconciles state against the LIVE fetch each run (the API
 * filters by an event's END time, so an all-day or in-progress event stays in
 * the window until it ends; time-based pruning would drop it and re-flag it as
 * new every run). A recurring series alerts ONCE, when it first appears.
 *
 * Known v1 limits: a cancellation is not detected (a cancelled event drops out
 * of the list); a per-occurrence reschedule of an already-known recurring
 * series is not flagged; the event title stays in the private digest and is
 * kept OFF the ntfy channel (label + time only), like the Stripe sibling.
 */

const RAW_DIR = '01-raw/calendar';
const STATE_FILE = '08-auto/_calendar-sonde.json';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars';

const DEFAULT_HORIZON_DAYS = 30; // how far ahead to watch
const PAGE_LIMIT = 250; // events per page (API max 2500)
const MAX_PAGES = 10; // pagination guard: 2500 events per run, ample for a solo

// --- injectable fetch (real fetch in prod, a fake in tests) -------------------

export interface ProbeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ProbeResponse>;

// --- shapes -------------------------------------------------------------------

export interface CalendarCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface CalendarProbeDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  /** OAuth creds. Defaults to the GOOGLE_OAUTH_* env. Absent/null = dormant. */
  creds?: CalendarCreds | null;
  /** Calendar id. Defaults to GOOGLE_CALENDAR_ID or 'primary'. */
  calendarId?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: ProbeFetch;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => Date;
}

export interface CalendarProbeResult {
  skipped: boolean;
  /** New + rescheduled events actually written to the digest this run. */
  events: number;
  added: number;
  moved: number;
  files: string[];
  error?: string;
}

interface ProbeState {
  version: 1;
  /** Single-event id -> its start key (raw start string), to detect reschedules. */
  seen: Record<string, string>;
  /** Recurring series id (recurringEventId) already alerted, to alert once. */
  seenSeries: Record<string, true>;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  htmlLink?: string;
}

type ChangeKind = 'new' | 'moved';

interface Change {
  digestLine: string;
  notifyText: string;
  ms: number;
  kind: ChangeKind;
}

// --- helpers ------------------------------------------------------------------

/** Never emit an em-dash (rule of the cerveau; the git hook blocks it too). */
function sansEmDash(text: string): string {
  return text.replace(/ — /g, ' : ').replace(/—/g, ' : ');
}

/** Raw start string used both as a change key and to derive labels/ms. */
export function startKeyOf(evt: CalendarEvent): string | null {
  return evt.start?.dateTime ?? evt.start?.date ?? null;
}

/** Human label from a start key. "2026-07-30 à 14:00" or "2026-07-30 (journée)". */
export function startLabel(key: string): string {
  const timed = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(key);
  if (timed) return `${timed[1]} à ${timed[2]}`;
  const allDay = /^(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (allDay) return `${allDay[1]} (journée)`;
  return key;
}

/** Epoch ms of a start key (for sorting). */
export function startMs(key: string): number {
  const timed = /^\d{4}-\d{2}-\d{2}T/.test(key);
  const ms = Date.parse(timed ? key : `${key}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

const KIND_LABEL: Record<ChangeKind, string> = {
  new: 'nouveau RDV',
  moved: 'RDV déplacé',
};

/**
 * Build the digest and notification lines for a changed event. The digest line
 * carries the title (private vault); the notify line is PII-free (label + time
 * only), so a third party's name never reaches the ntfy channel.
 */
export function describeChange(evt: CalendarEvent, kind: ChangeKind): {
  line: string;
  notifyLine: string;
} | null {
  const key = startKeyOf(evt);
  if (!key) return null;
  const label = startLabel(key);
  const title = sansEmDash((evt.summary ?? '(sans titre)').trim() || '(sans titre)');
  return {
    line: sansEmDash(`- ${label} · ${KIND_LABEL[kind]} : ${title}`),
    notifyLine: sansEmDash(`${KIND_LABEL[kind]} (${label})`),
  };
}

// --- service ------------------------------------------------------------------

export class CalendarProbeService {
  private readonly fetchImpl: ProbeFetch;
  private readonly now: () => Date;
  private readonly creds: CalendarCreds | null;
  private readonly calendarId: string;
  private readonly horizonDays: number;

  constructor(private readonly deps: CalendarProbeDeps) {
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as ProbeFetch);
    this.now = deps.now ?? (() => new Date());
    this.creds = 'creds' in deps ? (deps.creds ?? null) : resolveEnvCreds();
    this.calendarId = deps.calendarId ?? process.env.GOOGLE_CALENDAR_ID ?? 'primary';
    const envH = Number(process.env.CALENDAR_HORIZON_DAYS);
    this.horizonDays = Number.isFinite(envH) && envH > 0 ? envH : DEFAULT_HORIZON_DAYS;
  }

  async runProbe(): Promise<CalendarProbeResult> {
    const empty: CalendarProbeResult = { skipped: true, events: 0, added: 0, moved: 0, files: [] };
    if (!this.creds) {
      logger.info('Calendar probe dormant (GOOGLE_OAUTH_* absent)');
      return empty;
    }

    let fetched: { events: CalendarEvent[]; truncated: boolean };
    try {
      const token = await this.accessToken();
      fetched = await this.fetchUpcoming(token);
    } catch (error) {
      const msg = String(error).slice(0, 200);
      logger.warn('Calendar probe fetch failed', { error: msg });
      // Google returns invalid_grant (HTTP 400) for a revoked/expired token: the
      // literal, not the status, is what tells us to raise a fixable alarm.
      if (/invalid_grant|\b(400|401|403)\b|permission|unauthorized/i.test(msg) && this.deps.notify) {
        await this.deps.notify.push({
          title: 'Agenda : accès à corriger',
          message: sansEmDash('La sonde Agenda ne peut pas lire : jeton OAuth révoqué ou expiré.'),
          priority: 4,
          tags: ['warning', 'calendar'],
        });
      }
      return { ...empty, skipped: false, error: msg };
    }

    const { events, truncated } = fetched;
    const state = await this.loadState();
    const today = new Date(this.now().getTime()).toISOString().slice(0, 10);

    const changes: Change[] = [];
    const liveIds = new Set<string>();
    const liveSeries = new Set<string>();

    for (const evt of events) {
      if (!evt || !evt.id || evt.status === 'cancelled') continue;
      const key = startKeyOf(evt);
      if (!key) continue;
      const rid = typeof evt.recurringEventId === 'string' ? evt.recurringEventId : null;
      let kind: ChangeKind | null = null;
      if (rid) {
        // A recurring series alerts once: later occurrences sliding into the
        // window carry a fresh per-occurrence id but the same series id.
        liveSeries.add(rid);
        if (!state.seenSeries[rid]) kind = 'new';
        state.seenSeries[rid] = true;
      } else {
        liveIds.add(evt.id);
        const prev = state.seen[evt.id];
        if (prev === undefined) kind = 'new';
        else if (prev !== key) kind = 'moved';
        state.seen[evt.id] = key;
      }
      if (!kind) continue;
      const described = describeChange(evt, kind);
      if (!described) continue;
      changes.push({ digestLine: described.line, notifyText: described.notifyLine, ms: startMs(key), kind });
    }

    // Reconcile state against the live snapshot: forget only what the API no
    // longer returns (ended or fell past the horizon). Skip when the fetch was
    // truncated, so a still-live id on an unfetched page is not dropped and
    // re-flagged next run.
    if (!truncated) {
      for (const id of Object.keys(state.seen)) if (!liveIds.has(id)) delete state.seen[id];
      for (const rid of Object.keys(state.seenSeries)) if (!liveSeries.has(rid)) delete state.seenSeries[rid];
    }
    // Persist state BEFORE the digest write: a transient write error must not
    // lose the "seen" set and cause a re-notification storm next run.
    await this.saveState(state);

    // Notify only about lines actually written (dedup against today's file), so
    // a re-detected-but-already-logged event never pings.
    let added = 0;
    let moved = 0;
    const files: string[] = [];
    let notifyChanges: Change[] = [];
    if (changes.length > 0) {
      const { rel, fresh } = await this.appendDigest(today, changes.map(c => c.digestLine));
      if (fresh.length > 0) {
        files.push(rel);
        const freshSet = new Set(fresh);
        notifyChanges = changes.filter(c => freshSet.has(c.digestLine));
        added = notifyChanges.filter(c => c.kind === 'new').length;
        moved = notifyChanges.filter(c => c.kind === 'moved').length;
      }
    }

    if (notifyChanges.length > 0 && this.deps.notify) {
      await this.deps.notify.push(this.buildNotification(added, moved, notifyChanges));
    }

    return { skipped: false, events: added + moved, added, moved, files };
  }

  private async accessToken(): Promise<string> {
    const creds = this.creds!;
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }).toString();
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OAuth token ${res.status}: ${errBody.slice(0, 120)}`);
    }
    const payload = (await res.json()) as { access_token?: string };
    if (!payload?.access_token) throw new Error('OAuth token: no access_token in response');
    return payload.access_token;
  }

  /**
   * List upcoming events across the horizon, paginating via nextPageToken so a
   * busy month is never truncated. Returns `truncated` when the page guard was
   * hit, so the caller can skip state reconciliation on incomplete data.
   */
  private async fetchUpcoming(token: string): Promise<{ events: CalendarEvent[]; truncated: boolean }> {
    const nowIso = new Date(this.now().getTime()).toISOString();
    const maxIso = new Date(this.now().getTime() + this.horizonDays * 86400000).toISOString();
    const all: CalendarEvent[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams();
      params.set('timeMin', nowIso);
      params.set('timeMax', maxIso);
      params.set('singleEvents', 'true');
      params.set('orderBy', 'startTime');
      params.set('maxResults', String(PAGE_LIMIT));
      if (pageToken) params.set('pageToken', pageToken);
      const url = `${CALENDAR_API}/${encodeURIComponent(this.calendarId)}/events?${params.toString()}`;

      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Calendar API ${res.status}: ${body.slice(0, 120)}`);
      }
      const payload = (await res.json()) as { items?: CalendarEvent[]; nextPageToken?: string };
      const items = Array.isArray(payload?.items) ? payload.items : [];
      all.push(...items);
      if (!payload?.nextPageToken) return { events: all, truncated: false };
      pageToken = payload.nextPageToken;
    }
    logger.warn('Calendar probe hit MAX_PAGES; some events may remain unfetched', { pages: MAX_PAGES });
    return { events: all, truncated: true };
  }

  private buildNotification(added: number, moved: number, changes: Change[]) {
    const bits: string[] = [];
    if (added > 0) bits.push(`${added} nouveau(x) RDV`);
    if (moved > 0) bits.push(`${moved} RDV déplacé(s)`);
    const soonest = [...changes].sort((a, b) => a.ms - b.ms).slice(0, 3).map(c => c.notifyText);
    const detail = soonest.join(' ; ');
    const message = sansEmDash(`${bits.join(', ')}${detail ? `. ${detail}` : ''}`);
    return {
      title: 'Agenda : du nouveau',
      message,
      priority: 3,
      tags: ['calendar'],
    };
  }

  private async appendDigest(day: string, lines: string[]): Promise<{ rel: string; fresh: string[] }> {
    const rel = `${RAW_DIR}/${day}.md`;
    let base: string;
    try {
      base = (await this.deps.vault.readFile(rel)).replace(/\n+$/, '');
    } catch {
      base = [
        '---',
        'type: raw',
        'tags: [calendar, agenda]',
        `created: ${day}`,
        '---',
        '',
        `# Agenda : changements repérés le ${day}`,
        '',
        `> Nouveaux RDV et RDV déplacés sur les ${this.horizonDays} prochains jours, rendus`,
        '> visibles au cerveau (lecture seule). Le brief et la war-room lisent ce dossier.',
        '',
      ].join('\n');
    }
    // Whole-line dedup (a substring test would drop a distinct shorter line).
    const existing = new Set(base.split('\n'));
    const fresh = lines.filter(l => !existing.has(l));
    if (fresh.length > 0) {
      await this.deps.vault.writeFile(rel, `${base}\n${fresh.join('\n')}\n`);
    }
    return { rel, fresh };
  }

  private async loadState(): Promise<ProbeState> {
    const empty: ProbeState = { version: 1, seen: {}, seenSeries: {} };
    try {
      const raw = await this.deps.vault.readFile(STATE_FILE);
      const parsed = JSON.parse(raw) as Partial<ProbeState>;
      return { version: 1, seen: parsed.seen ?? {}, seenSeries: parsed.seenSeries ?? {} };
    } catch {
      return empty;
    }
  }

  private async saveState(state: ProbeState): Promise<void> {
    await writeStateFile(this.deps.vault, STATE_FILE, JSON.stringify(state, null, 2));
  }
}

function resolveEnvCreds(): CalendarCreds | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}
