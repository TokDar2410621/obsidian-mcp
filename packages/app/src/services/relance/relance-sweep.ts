import crypto from 'crypto';
import type { VaultManager } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import { logger } from '@/utils/logger';

/**
 * Relance sweep: when Darius owes an action and a day passes with no progress,
 * the brain does not nag — it asks WHY, with one-tap answer buttons (ntfy view
 * actions hitting the token-gated /reponse endpoint). His answer names the real
 * cause; the deep agents then dissolve the cause, not the symptom (rule
 * `blocage-demander-pourquoi`).
 *
 * Watched sources:
 *  - `09-taches/_darius.md`: his personal checklist (`- [ ] action (ajouté: date)`),
 *    fed by the `todo:` capture prefix, war-room actions and insight gestes.
 *  - `09-taches/*.md` tasks sitting in `statut: a-valider` (they wait on him).
 * One ntfy per run (the oldest item), the rest is counted — noise stays dead.
 * Re-asks the same item only after REASK_DAYS of continued silence.
 */
const TACHES_DIR = '09-taches';
const DARIUS_FILE = `${TACHES_DIR}/_darius.md`;
const REPONSES_FILE = `${TACHES_DIR}/_reponses.md`;
/** Recurring reminders, written by the portier from RAPPEL captures
 *  (« rappelle-moi X chaque 2 semaines »). One line each:
 *  `- [ ] action · chaque: Nj · prochain: AAAA-MM-JJ`. */
const RAPPELS_FILE = `${TACHES_DIR}/_rappels.md`;
const STATE_FILE = '08-auto/_relances-state.json';
const STALL_DAYS = 1;
const REASK_DAYS = 3;

const RAPPEL_RE = /^(\s*-\s*\[( |x|X)\]\s*)(.+?)\s*·\s*chaque:\s*(\d+)j\s*·\s*prochain:\s*(\d{4}-\d{2}-\d{2})\s*$/;

export interface RelanceItem {
  id: string;
  kind: 'darius' | 'tache';
  title: string;
  file: string;
  ageDays: number;
}

export interface RelanceResult {
  watched: number;
  stalled: number;
  asked: string | null;
}

interface RelanceState {
  version: 1;
  /** item id -> last asked date (YYYY-MM-DD). */
  asked: Record<string, string>;
}

export interface RelanceDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  /** Public base URL of this server (for the one-tap answer links). */
  baseUrl: string;
  /** Capture token gating /reponse. Buttons are disabled when absent. */
  token: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(dateIso: string): number {
  const t = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.parse(`${todayIso()}T00:00:00Z`) - t) / 86_400_000);
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export class RelanceSweepService {
  constructor(private readonly deps: RelanceDeps) {}

  async runSweep(): Promise<RelanceResult> {
    await this.runRappels().catch(error => logger.warn('Rappels sweep failed', { error: String(error) }));
    const state = await this.loadState();
    const items = [...(await this.dariusItems()), ...(await this.pendingTasks())];
    const stalled = items
      .filter(i => i.ageDays >= STALL_DAYS)
      .filter(i => {
        const last = state.asked[i.id];
        return !last || daysSince(last) >= REASK_DAYS;
      })
      .sort((a, b) => b.ageDays - a.ageDays);

    let asked: string | null = null;
    if (stalled.length > 0 && this.deps.notify) {
      const top = stalled[0];
      const others = stalled.length - 1;
      const lines = [
        `${top.ageDays} jour(s) sans avancement : ${top.title}`,
        'Pourquoi ? Un tap ci-dessous, ou réponds en vocal via la capture (préfixe « pk: »).',
      ];
      if (others > 0) lines.push(`(${others} autre(s) en retard : ${TACHES_DIR}/)`);
      await this.deps.notify.push({
        title: 'Le cerveau te demande pourquoi',
        message: lines.join('\n'),
        priority: 4,
        tags: ['thinking_face'],
        actions: this.answerButtons(top),
      });
      state.asked[top.id] = todayIso();
      asked = top.title;
      await this.saveState(state);
    }

    const result: RelanceResult = { watched: items.length, stalled: stalled.length, asked };
    logger.info('Relance sweep done', { ...result });
    return result;
  }

  /**
   * Recurring reminders: every unchecked line of `_rappels.md` whose `prochain`
   * date is due gets ONE ntfy push, then its date is pushed one period ahead.
   * A checked box (`- [x]`) retires the reminder for good. No per-item cron:
   * this rides the existing daily sweep.
   */
  private async runRappels(): Promise<void> {
    let content: string;
    try {
      content = await this.deps.vault.readFile(RAPPELS_FILE);
    } catch {
      return; // no reminders yet
    }
    const today = todayIso();
    const dus: string[] = [];
    let changed = false;
    const lines = content.split(/\r?\n/).map(line => {
      const m = RAPPEL_RE.exec(line);
      if (!m || m[2] !== ' ') return line; // not a reminder, or retired ([x])
      const [, prefix, , action, period, prochain] = m;
      if (prochain > today) return line;
      // Due (or overdue, e.g. the server slept): notify once, rebump from today.
      dus.push(action);
      changed = true;
      const next = new Date(Date.parse(`${today}T00:00:00Z`) + Number(period) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return `${prefix}${action} · chaque: ${period}j · prochain: ${next}`;
    });
    if (!changed) return;
    if (this.deps.notify) {
      await this.deps.notify.push({
        title: dus.length === 1 ? 'Rappel' : `${dus.length} rappels`,
        message: dus.map(a => `⏰ ${a}`).join('\n'),
        priority: 4,
        tags: ['alarm_clock'],
      });
    }
    await this.deps.vault.writeFile(RAPPELS_FILE, lines.join('\n'));
    logger.info('Rappels sweep done', { due: dus.length });
  }

  private answerButtons(item: RelanceItem): { label: string; url: string }[] {
    const { baseUrl, token } = this.deps;
    if (!token) return [];
    const base = `${baseUrl.replace(/\/+$/, '')}/reponse?k=${encodeURIComponent(token)}&t=${encodeURIComponent(item.title.slice(0, 80))}&f=${encodeURIComponent(item.file)}`;
    return [
      { label: 'Il me manque un truc', url: `${base}&c=manque` },
      { label: 'Pas envie / peur', url: `${base}&c=peur` },
      { label: 'Plus pertinent', url: `${base}&c=abandon` },
    ];
  }

  /** Unchecked items of `_darius.md`: `- [ ] action (ajouté: YYYY-MM-DD)`. */
  private async dariusItems(): Promise<RelanceItem[]> {
    let content = '';
    try {
      content = await this.deps.vault.readFile(DARIUS_FILE);
    } catch {
      return [];
    }
    const items: RelanceItem[] = [];
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*[-*]\s*\[ \]\s*(.+)$/.exec(line);
      if (!m) continue;
      const title = m[1].trim();
      const dateM = /\(ajout[ée]?\s*:\s*(\d{4}-\d{2}-\d{2})\)/i.exec(title);
      const age = dateM ? daysSince(dateM[1]) : STALL_DAYS; // undated items count as stalled
      items.push({
        id: `darius::${sha(title)}`,
        kind: 'darius',
        title: title.replace(/\s*\(ajout[ée]?\s*:.*?\)\s*/i, '').trim(),
        file: DARIUS_FILE,
        ageDays: age,
      });
    }
    return items;
  }

  /** Task files waiting on Darius (`statut: a-valider`). */
  private async pendingTasks(): Promise<RelanceItem[]> {
    const { vault } = this.deps;
    let files: string[] = [];
    try {
      files = await vault.listFiles(TACHES_DIR, { fileTypes: ['md'], recursive: false });
    } catch {
      return [];
    }
    const items: RelanceItem[] = [];
    for (const raw of files) {
      const file = raw.startsWith(TACHES_DIR) ? raw : `${TACHES_DIR}/${raw}`;
      const base = file.split('/').pop() ?? '';
      if (base.startsWith('_')) continue;
      let content = '';
      try {
        content = await vault.readFile(file);
      } catch {
        continue;
      }
      if (!/^statut\s*:\s*a-valider\s*$/m.test(content)) continue;
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? base;
      const created = /^created\s*:\s*(\d{4}-\d{2}-\d{2})/m.exec(content)?.[1];
      items.push({
        id: `tache::${sha(file)}`,
        kind: 'tache',
        title: `Valider : ${title}`,
        file,
        ageDays: created ? daysSince(created) : STALL_DAYS,
      });
    }
    return items;
  }

  private async loadState(): Promise<RelanceState> {
    const empty: RelanceState = { version: 1, asked: {} };
    try {
      const parsed = JSON.parse(await this.deps.vault.readFile(STATE_FILE)) as Partial<RelanceState>;
      return { ...empty, ...parsed, asked: parsed.asked ?? {} };
    } catch {
      return empty;
    }
  }

  private async saveState(state: RelanceState): Promise<void> {
    await this.deps.vault.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

/** Append a one-tap (or `pk:` capture) answer where the deep agents will read it. */
export async function recordAnswer(
  vault: VaultManager,
  title: string,
  file: string,
  cause: string,
  note?: string,
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const header = [
    '---',
    'type: note',
    'tags: [taches, reponses]',
    '---',
    '',
    '# Réponses de Darius aux relances',
    '',
    "> Chaque ligne nomme la vraie cause d'un blocage. L'agent quotidien et le penseur",
    '> de nuit lisent ce fichier et dissolvent la cause, pas le symptôme.',
    '',
  ].join('\n');
  let body = '';
  try {
    const existing = await vault.readFile(REPONSES_FILE);
    const idx = existing.indexOf('\n- ');
    body = idx >= 0 ? existing.slice(idx) : '';
  } catch {
    body = '';
  }
  const line = `\n- ${stamp} · [${cause}] ${title} (${file})${note ? ` : ${note}` : ''}`;
  await vault.writeFile(REPONSES_FILE, header + line + body);
}
