import crypto from 'crypto';
import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
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
/** After Darius ANSWERS (manque/peur), leave the dissolution engine 7 days
 *  before asking the same cause again. An answered signal is not a stalled one. */
const REASK_ANSWERED_DAYS = 7;

const RAPPEL_RE = /^(\s*-\s*\[( |x|X)\]\s*)(.+?)\s*·\s*chaque:\s*(\d+)j\s*·\s*prochain:\s*(\d{4}-\d{2}-\d{2})\s*$/;

export interface RelanceItem {
  id: string;
  kind: 'darius' | 'tache' | 'echec';
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
  /** answerKey -> date Darius answered (manque/peur). Quiets re-asks 7 days. */
  answered: Record<string, string>;
}

/** Stable key tying a one-tap answer back to its relance item (title is
 *  truncated to 80 chars in the button URL, so slice before hashing). */
export function answerKey(title: string, file: string): string {
  return sha(`${title.slice(0, 80)}::${file}`);
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
      .filter(i => {
        // Darius answered this one (manque/peur): leave the dissolution engine
        // room to work before asking the same cause again.
        const answeredAt = state.answered[answerKey(i.title, i.file)];
        return !answeredAt || daysSince(answeredAt) >= REASK_ANSWERED_DAYS;
      })
      .sort((a, b) => b.ageDays - a.ageDays);

    let asked: string | null = null;
    if (stalled.length > 0 && this.deps.notify) {
      const top = stalled[0];
      const others = stalled.length - 1;
      if (top.kind === 'echec') {
        // A dead task is a signal, never a silence. One tap relaunches it
        // (approuvee: the chef picks it up) or buries it for good.
        const erreur = await this.errorExcerpt(top.file);
        const lines = [erreur || 'La tâche a échoué chez le chef de chantier.', 'Relancer la renvoie au chef ; Abandonner la jette.'];
        if (others > 0) lines.push(`(${others} autre(s) en attente : Revue)`);
        await this.deps.notify.push({
          title: `Tâche échouée : ${top.title.slice(0, 90)}`,
          message: lines.join('\n'),
          priority: 4,
          tags: ['boom'],
          actions: this.relaunchButtons(top),
        });
      } else if (top.kind === 'tache') {
        // Output loop: a finished deliverable SERVES itself with its decision
        // buttons instead of a guilt trip. One tap ends it.
        const extrait = await this.resultExcerpt(top.file);
        const lines = [extrait || 'Le livrable est prêt et contrôlé.', 'Valider garde, Rejeter jette.'];
        if (others > 0) lines.push(`(${others} autre(s) en attente : Revue)`);
        await this.deps.notify.push({
          title: `Livrable prêt : ${top.title.replace(/^Valider : /, '').slice(0, 90)}`,
          message: lines.join('\n'),
          priority: 4,
          tags: ['gift'],
          actions: this.decisionButtons(top),
        });
      } else {
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
      }
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
    // ntfy caps at 3 buttons. « Déjà fait » coche la boucle dans le vault :
    // la déclaration de Darius EST la validation. « peur » reste dicible en pk:.
    return [
      { label: 'Déjà fait', url: `${base}&c=fait` },
      { label: 'Il me manque un truc', url: `${base}&c=manque` },
      { label: 'Plus pertinent', url: `${base}&c=abandon` },
    ];
  }

  /** Valider / Rejeter d'un livrable, directement dans la notification. */
  private decisionButtons(item: RelanceItem): { label: string; url: string }[] {
    const { baseUrl, token } = this.deps;
    if (!token) return [];
    const root = baseUrl.replace(/\/+$/, '');
    const k = encodeURIComponent(token);
    const t = encodeURIComponent(item.file);
    return [
      { label: 'Valider', url: `${root}/valide?k=${k}&t=${t}` },
      { label: 'Rejeter', url: `${root}/rejette?k=${k}&t=${t}` },
      { label: 'Revue', url: `${root}/revue?k=${k}` },
    ];
  }

  /** Relancer (statut approuvee, le chef la reprend) ou abandonner une tâche morte. */
  private relaunchButtons(item: RelanceItem): { label: string; url: string }[] {
    const { baseUrl, token } = this.deps;
    if (!token) return [];
    const root = baseUrl.replace(/\/+$/, '');
    const k = encodeURIComponent(token);
    const t = encodeURIComponent(item.file);
    return [
      { label: 'Relancer', url: `${root}/approuve?k=${k}&t=${t}` },
      { label: 'Abandonner', url: `${root}/rejette?k=${k}&t=${t}` },
      { label: 'Revue', url: `${root}/revue?k=${k}` },
    ];
  }

  /** Dernière erreur du `## Journal` d'une tâche échouée. */
  private async errorExcerpt(file: string): Promise<string | null> {
    try {
      const content = await this.deps.vault.readFile(file);
      const m = content.match(/^.*(?:Erreur worker|NON CONFORME|erreur)\s*:?.*$/gim);
      if (!m || m.length === 0) return null;
      const line = m[0].trim();
      return line.length > 160 ? `${line.slice(0, 157)}...` : line;
    } catch {
      return null;
    }
  }

  /** Première ligne du `## Résultat` d'une tâche : le livrable, pas le blabla. */
  private async resultExcerpt(file: string): Promise<string | null> {
    try {
      const content = await this.deps.vault.readFile(file);
      const section = /##\s*Résultat\s*\n([\s\S]*?)(?=\n## |$)/.exec(content)?.[1] ?? '';
      const line = section
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l && !l.startsWith('#'));
      if (!line) return null;
      const clean = line.replace(/^[-*>]\s*/, '').replace(/\*\*/g, '');
      return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
    } catch {
      return null;
    }
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
      const statut = /^statut\s*:\s*(\S+)\s*$/m.exec(content)?.[1] ?? '';
      // a-valider: a deliverable waits for a decision. echouee: a task DIED
      // and nothing used to say so (the resto pilot failed on 2026-07-10 and
      // stayed invisible until a hand-audit found it).
      if (statut !== 'a-valider' && statut !== 'echouee') continue;
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? base;
      const created = /^created\s*:\s*(\d{4}-\d{2}-\d{2})/m.exec(content)?.[1];
      const echec = statut === 'echouee';
      items.push({
        id: `${echec ? 'echec' : 'tache'}::${sha(file)}`,
        kind: echec ? 'echec' : 'tache',
        title: echec ? title : `Valider : ${title}`,
        file,
        ageDays: created ? daysSince(created) : STALL_DAYS,
      });
    }
    return items;
  }

  private async loadState(): Promise<RelanceState> {
    const empty: RelanceState = { version: 1, asked: {}, answered: {} };
    try {
      const parsed = JSON.parse(await this.deps.vault.readFile(STATE_FILE)) as Partial<RelanceState>;
      return { ...empty, ...parsed, asked: parsed.asked ?? {}, answered: parsed.answered ?? {} };
    } catch {
      return empty;
    }
  }

  private async saveState(state: RelanceState): Promise<void> {
    await writeStateFile(this.deps.vault, STATE_FILE, JSON.stringify(state, null, 2));
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

/**
 * EXECUTE a terminal answer instead of only recording it. « abandonner » and
 * « déjà fait » are decisions, not causes: the open loop they answer must
 * close in the vault at the tap (the Any Claude testimonial was re-nagged for
 * 3 days after its « abandonner » answer because nothing consumed it).
 * Returns a short description of what happened, or null if no loop matched.
 */
export async function consumeAnswer(
  vault: VaultManager,
  cause: 'abandon' | 'fait',
  title: string,
  file: string,
): Promise<string | null> {
  const day = todayIso();
  if (file === DARIUS_FILE) {
    let content: string;
    try {
      content = await vault.readFile(DARIUS_FILE);
    } catch {
      return null;
    }
    const needle = title.toLowerCase().slice(0, 40);
    const suffix = cause === 'fait' ? ` (fait, déclaré: ${day})` : ` (abandonné: ${day})`;
    let hit = false;
    const out = content.split(/\r?\n/).map(line => {
      if (hit) return line;
      const m = /^(\s*[-*]\s*)\[ \](\s*)(.+)$/.exec(line);
      if (!m) return line;
      const text = m[3].replace(/\s*\(ajout[ée]?\s*:.*?\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
      if (!text.toLowerCase().startsWith(needle)) return line;
      hit = true;
      return `${m[1]}[x]${m[2]}${m[3]}${suffix}`;
    });
    if (!hit) return null;
    await vault.writeFile(DARIUS_FILE, out.join('\n'));
    return cause === 'fait' ? 'coché comme fait dans ta liste' : 'coché comme abandonné dans ta liste';
  }
  if (/^09-taches\/[^_/][^/]*\.md$/.test(file)) {
    let content: string;
    try {
      content = await vault.readFile(file);
    } catch {
      return null;
    }
    const statut = cause === 'fait' ? 'validee' : 'rejetee';
    const next = content.replace(/^statut\s*:\s*.+$/m, `statut: ${statut}`);
    if (next === content) return null;
    await vault.writeFile(file, next);
    return `tâche passée ${statut}`;
  }
  return null;
}

/** Note that Darius ANSWERED (manque/peur): the relance stays quiet 7 days on it. */
export async function markAnswered(vault: VaultManager, title: string, file: string): Promise<void> {
  let state: { version: 1; asked: Record<string, string>; answered: Record<string, string> } = {
    version: 1,
    asked: {},
    answered: {},
  };
  try {
    const parsed = JSON.parse(await vault.readFile(STATE_FILE)) as Partial<typeof state>;
    state = { ...state, ...parsed, asked: parsed.asked ?? {}, answered: parsed.answered ?? {} };
  } catch {
    /* first answer ever */
  }
  state.answered[answerKey(title, file)] = todayIso();
  await writeStateFile(vault, STATE_FILE, JSON.stringify(state, null, 2));
}
