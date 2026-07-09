import type { VaultManager } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import type { ObjectiveNote } from '@/services/objectives/objective-sweep';
import type { ConclusionsRegistry } from '@/services/conclusions/conclusions-registry';
import { collectDailyPropositions, cleanText } from '@/server/local/validation-route';
import { logger } from '@/utils/logger';

/**
 * Morning brief: the vault's return path to the human. Once a day it composes
 * ONE ntfy push from what already lives in the vault, so Darius never has to
 * go read `08-auto/` himself:
 *   1. the nearest objective deadline still blocked by open conditions,
 *   2. his own #1 priority (top of `08-auto/_priorities.md`, which he edits),
 *   3. how many NEW proposals are waiting for him since the last brief
 *      (objective sweep, capture links, the reflection inbox).
 * Deterministic, no LLM. Also appends a dated record to `08-auto/_brief-matin.md`.
 */
const AUTO_DIR = '08-auto';
const STATE_FILE = `${AUTO_DIR}/_brief-state.json`;
const RECORD_FILE = `${AUTO_DIR}/_brief-matin.md`;
const PRIORITIES_FILE = `${AUTO_DIR}/_priorities.md`;
const QUESTION_FILE = `${AUTO_DIR}/_question.md`;
/** Heartbeats written by the PC2 workers at every run (even silent ones). */
const HEARTBEAT_FILE = `${AUTO_DIR}/_veille-workers.json`;
const WATCHED_WORKERS: Array<{ key: string; label: string; staleMs: number }> = [
  { key: 'penseur-de-nuit', label: 'Penseur de nuit', staleMs: 26 * 3600 * 1000 },
  { key: 'chef-de-chantier', label: 'Chef de chantier', staleMs: 8 * 3600 * 1000 },
];

/** Files whose fresh bullets count as "waiting for Darius". */
const INSIGHTS_FILE = `${AUTO_DIR}/_insights.md`;
const PENDING_FILES = [
  INSIGHTS_FILE,
  `${AUTO_DIR}/_objectifs-propositions.md`,
  `${AUTO_DIR}/_captures-liens.md`,
  `${AUTO_DIR}/_inbox-darius.md`,
];
const PENDING_LABELS: Record<string, string> = {
  [INSIGHTS_FILE]: 'insights',
  [`${AUTO_DIR}/_objectifs-propositions.md`]: 'objectifs',
  [`${AUTO_DIR}/_captures-liens.md`]: 'captures reliées',
  [`${AUTO_DIR}/_inbox-darius.md`]: 'inbox cerveau',
};
const MAX_RECORD_SECTIONS = 30;

export interface ObjectiveSource {
  loadObjectives(): Promise<ObjectiveNote[]>;
}

export interface MorningBriefDeps {
  objectives: ObjectiveSource;
  vault: VaultManager;
  notify?: NotifyPusher | null;
  /** Public server URL, for the one-tap "Répondre" button. */
  baseUrl?: string;
  /** Capture token, gating the answer page. Button omitted when absent. */
  token?: string | null;
  /** Conclusions registry: settled matters never count as pending again. */
  conclusions?: ConclusionsRegistry | null;
  /** Live HTTP telemetry of the workers (their voice when git is frozen). */
  telemetry?: (() => Record<string, { last: string; ahead?: number }>) | null;
}

export interface BriefResult {
  sent: boolean;
  reason?: string;
  deadline?: string;
  priority?: string;
  pending: number;
}

interface BriefState {
  version: 1;
  lastSentDate: string; // YYYY-MM-DD (UTC)
  bulletCounts: Record<string, number>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateIso: string): number {
  const target = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(target)) return Number.POSITIVE_INFINITY;
  const now = Date.parse(`${todayIso()}T00:00:00Z`);
  return Math.round((target - now) / 86_400_000);
}

function countBullets(content: string): number {
  return content.split(/\r?\n/).filter(l => /^\s*[-*]\s+\S/.test(l)).length;
}

/** Strip wikilinks/bold and clamp, so the line reads clean inside a push. */
function clean(text: string, max = 140): string {
  const t = text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/**
 * Headline of the newest insight section: the first `- **[type] Title**` bullet
 * written by the night thinker. Returns null when the file has no insight yet.
 */
export function parseLatestInsight(content: string): string | null {
  const idx = content.indexOf('\n## ');
  const top = (idx >= 0 ? content.slice(idx) : content).replace(/^\n+/, '');
  const section = top.split(/\n(?=## )/)[0] ?? '';
  const m = /^-\s*\*\*\[([a-zé]+)\]\s*(.+?)\*\*/im.exec(section);
  return m ? clean(`${m[1]} : ${m[2]}`, 120) : null;
}

/** The newest question written by the night thinker (first line of top section). */
export function parseLatestQuestion(content: string): string | null {
  const idx = content.indexOf('\n## ');
  const top = (idx >= 0 ? content.slice(idx) : content).replace(/^\n+/, '');
  const section = top.split(/\n(?=## )/)[0] ?? '';
  for (const line of section.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('>')) return clean(t, 160);
  }
  return null;
}

/** First numbered item under the "Priorités" heading of `_priorities.md`. */
export function parseTopPriority(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) inSection = /priorit/i.test(line);
    else if (inSection) {
      const m = /^\s*1[.)]\s+(.*)$/.exec(line);
      if (m) return clean(m[1]);
    }
  }
  // Fallback: first bullet or numbered line anywhere after frontmatter.
  const any = lines.find(l => /^\s*(?:[-*]|1[.)])\s+\S/.test(l));
  return any ? clean(any.replace(/^\s*(?:[-*]|1[.)])\s+/, '')) : null;
}

export class MorningBriefService {
  constructor(private readonly deps: MorningBriefDeps) {}

  async runBrief(force = false): Promise<BriefResult> {
    const { vault } = this.deps;
    const state = await this.loadState();
    const today = todayIso();
    if (!force && state.lastSentDate === today) {
      return { sent: false, reason: 'already sent today', pending: 0 };
    }

    // 1. Nearest deadline among open objectives with unmet conditions.
    let deadlineLine: string | null = null;
    try {
      const objectives = await this.deps.objectives.loadObjectives();
      const candidates = objectives
        .filter(o => (o.statut === 'ouvert' || o.statut === 'en-retard') && o.echeance)
        .map(o => ({ o, days: daysUntil(o.echeance as string), open: o.conditions.filter(c => !c.done).length }))
        .filter(x => x.open > 0)
        .sort((a, b) => a.days - b.days);
      const next = candidates[0];
      if (next) {
        const when =
          next.days < 0
            ? `DÉPASSÉE de ${-next.days} j`
            : next.days === 0
              ? "aujourd'hui"
              : `dans ${next.days} j`;
        deadlineLine = `Échéance : ${clean(next.o.title, 60)} (${next.o.echeance}, ${when}, ${next.open} condition(s) ouverte(s))`;
      }
    } catch (error) {
      logger.warn('Morning brief: objectives unavailable', { error: String(error) });
    }

    // 2. Darius's own #1 priority (he edits _priorities.md, we just quote it).
    let priorityLine: string | null = null;
    try {
      const top = parseTopPriority(await vault.readFile(PRIORITIES_FILE));
      if (top) priorityLine = `Priorité n°1 : ${top}`;
    } catch {
      /* no priorities file: skip the line */
    }

    // 3. New proposals waiting since the last brief (bullet-count deltas).
    const pendingParts: string[] = [];
    let pendingTotal = 0;
    let insightLine: string | null = null;
    const newCounts: Record<string, number> = { ...state.bulletCounts };
    for (const file of PENDING_FILES) {
      let content = '';
      try {
        content = await vault.readFile(file);
      } catch {
        content = '';
      }
      const count = countBullets(content);
      const prev = state.bulletCounts[file] ?? 0;
      const fresh = Math.max(0, count - prev);
      newCounts[file] = count;
      if (fresh > 0) {
        pendingTotal += fresh;
        pendingParts.push(`${fresh} ${PENDING_LABELS[file] ?? file}`);
        // A fresh insight is the star of the brief: quote its headline, first.
        if (file === INSIGHTS_FILE) {
          const headline = parseLatestInsight(content);
          if (headline) insightLine = `Insight : ${headline}`;
        }
      }
    }

    // Orphan channel: proposals the cloud ingestion left in the newest daily
    // note. Settled conclusions (validated, refused, promoted) are excluded,
    // even reformulated: an unticked checkbox must not re-serve done work.
    try {
      let dailyProps = await collectDailyPropositions(vault);
      if (dailyProps.length > 0 && this.deps.conclusions) {
        try {
          const mask = await this.deps.conclusions.settledMask(
            dailyProps.map(p => cleanText(p.text)),
          );
          dailyProps = dailyProps.filter((_, i) => !mask[i]);
        } catch {
          /* mask failure: fall back to the raw count */
        }
      }
      if (dailyProps.length > 0) {
        pendingTotal += dailyProps.length;
        pendingParts.push(`${dailyProps.length} du carnet du jour`);
      }
    } catch {
      /* daily unavailable: skip */
    }

    // The night thinker's grill: today's question, if it wrote a fresh one.
    let questionLine: string | null = null;
    try {
      const q = await vault.readFile(QUESTION_FILE);
      if (new RegExp(`^##\\s+${today}\\b`, 'm').test(q)) {
        const parsed = parseLatestQuestion(q);
        if (parsed) questionLine = `Question du jour : ${parsed}\nRéponds en vocal : capture « pk: ... »`;
      }
    } catch {
      /* no question file yet */
    }

    // Watchdog: a silent failure of a PC2 worker must become a signal, never a
    // quietly thinner brief (observed: the whole PC2 layer down 24h, unseen).
    // Each worker heartbeats into the vault; a stale beat raises ONE line here.
    const watchdogLines: string[] = [];
    try {
      let hb: Record<string, { last?: string; ahead?: number }> = {};
      try {
        hb = JSON.parse(await vault.readFile(HEARTBEAT_FILE));
      } catch {
        /* no heartbeat file yet */
      }
      // Live HTTP telemetry wins over the vault file: it still speaks when the
      // git clone is frozen (the exact failure the vault channel cannot report).
      const live = this.deps.telemetry?.() ?? {};
      for (const w of WATCHED_WORKERS) {
        const beat = live[w.key] ?? hb[w.key];
        const last = beat?.last;
        // Bootstrap-safe: before any heartbeat exists, only the night thinker
        // alerts (its output file proves it is supposed to run).
        const known =
          last !== undefined ||
          (w.key === 'penseur-de-nuit' && (await vault.fileExists(INSIGHTS_FILE)));
        if (!known) continue;
        const stale = !last || Date.now() - Date.parse(last) > w.staleMs;
        if (stale) {
          watchdogLines.push(
            `⚠️ ${w.label} : aucun battement récent (dernier : ${last ?? 'jamais'}). Vérifier PC2.`,
          );
        } else if ((beat?.ahead ?? 0) > 0) {
          // Alive but its work is NOT reaching GitHub: the push verifier.
          watchdogLines.push(
            `⚠️ ${w.label} : vivant mais ${beat!.ahead} commit(s) non poussé(s). Le push de PC2 coince.`,
          );
        }
      }
    } catch {
      /* watchdog must never break the brief */
    }

    const lines = [questionLine, insightLine, ...watchdogLines, deadlineLine, priorityLine].filter(
      Boolean,
    ) as string[];
    if (pendingTotal > 0) lines.push(`En attente de toi : ${pendingParts.join(', ')} (08-auto)`);

    if (lines.length === 0) {
      // Nothing to say beats an empty ping.
      state.lastSentDate = today;
      state.bulletCounts = newCounts;
      await this.saveState(state);
      logger.info('Morning brief: nothing to report');
      return { sent: false, reason: 'nothing to report', pending: 0 };
    }

    if (this.deps.notify) {
      // One-tap "Répondre" when there is a question: opens the capture page
      // pre-filled with "pk: " so answering is a single dictation.
      const { baseUrl, token } = this.deps;
      const base = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
      const actions: { label: string; url: string }[] = [];
      if (base && token) {
        // One-tap "Répondre" when there is a question (opens capture prefilled),
        // then "Revue" to triage tasks + proposals. ntfy allows up to 3 actions.
        if (questionLine) {
          actions.push({
            label: 'Répondre',
            url: `${base}/capture/app?k=${encodeURIComponent(token)}&prefill=${encodeURIComponent('pk: ')}`,
          });
        }
        actions.push({ label: 'Revue', url: `${base}/revue?k=${encodeURIComponent(token)}` });
      }
      await this.deps.notify.push({
        title: 'Brief du matin',
        message: lines.join('\n'),
        priority: deadlineLine?.includes('DÉPASSÉE') ? 4 : 3,
        tags: ['sunrise'],
        ...(actions.length ? { actions } : {}),
      });
    }
    await this.appendRecord(lines);

    state.lastSentDate = today;
    state.bulletCounts = newCounts;
    await this.saveState(state);

    const result: BriefResult = {
      sent: true,
      deadline: deadlineLine ?? undefined,
      priority: priorityLine ?? undefined,
      pending: pendingTotal,
    };
    logger.info('Morning brief sent', { pending: pendingTotal, lines: lines.length });
    return result;
  }

  private async loadState(): Promise<BriefState> {
    const empty: BriefState = { version: 1, lastSentDate: '', bulletCounts: {} };
    try {
      const parsed = JSON.parse(await this.deps.vault.readFile(STATE_FILE)) as Partial<BriefState>;
      return { ...empty, ...parsed, bulletCounts: parsed.bulletCounts ?? {} };
    } catch {
      return empty;
    }
  }

  private async saveState(state: BriefState): Promise<void> {
    await this.deps.vault.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private async appendRecord(lines: string[]): Promise<void> {
    const { vault } = this.deps;
    const header = [
      '---',
      'type: note',
      'tags: [auto, brief]',
      '---',
      '',
      '# Brief du matin (auto)',
      '',
      '> Une entrée par jour : ce que le cerveau a poussé sur le téléphone.',
      '',
    ].join('\n');

    let body = '';
    try {
      const existing = await vault.readFile(RECORD_FILE);
      const idx = existing.indexOf('\n## ');
      body = idx >= 0 ? existing.slice(idx) : '';
    } catch {
      body = '';
    }

    const section = [`\n## ${todayIso()}`, '', ...lines.map(l => `- ${l}`), ''];
    const merged = section.join('\n') + body;
    const sections = merged.split(/\n(?=## )/).slice(0, MAX_RECORD_SECTIONS);
    await vault.writeFile(RECORD_FILE, header + sections.join('\n'));
  }
}
