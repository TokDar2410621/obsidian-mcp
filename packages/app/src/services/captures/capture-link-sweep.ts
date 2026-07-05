import crypto from 'crypto';
import type { VaultManager } from '@/services/vault-manager';
import type { EmbeddedChunk } from '@/services/rag/types';
import type { NotifyPusher } from '@/services/notify/notifier';
import type { SweepRag } from '@/services/objectives/objective-sweep';
import { dot } from '@/services/rag/cosine';
import { logger } from '@/utils/logger';

/**
 * Capture link sweep. Propose-only sibling of the objective sweep: where that
 * one closes objective conditions, this one makes CAPTURES serve. On each run it
 * reads the fresh capture bullets from `01-raw/inbox/`, embeds each one, and
 * cosine-matches it against the chunks of every project under `05-projects/`.
 * When a capture is strongly relevant to a project it stages a proposal under
 * `08-auto/` ("this capture could serve Gridar") and pushes one ntfy. Pure
 * embeddings over the existing index, no LLM. The concrete move ("how it makes
 * the project pass a cap") is decided by a human or the daily agent (section F2).
 */
const AUTO_DIR = '08-auto';
const STATE_FILE = `${AUTO_DIR}/_captures-liens-state.json`;
const PROPOSALS_FILE = `${AUTO_DIR}/_captures-liens.md`;
const INBOX_PREFIX = '01-raw/inbox/';
const PROJECT_PREFIX = '05-projects/';

// Captures are short bullets matched against note prose. Start at 0.5 and
// calibrate on the first real run (like the objective sweep went 0.45 -> 0.60).
const DEFAULT_THRESHOLD = 0.5; // cosine, tune with CAPTURE_LINK_THRESHOLD
const MAX_CAPTURES_PER_RUN = 60; // bound embedding cost per run
const MAX_PROPOSAL_SECTIONS = 30;

export interface CaptureLinkResult {
  captures: number;
  newCaptures: number;
  projects: number;
  proposals: number;
}

interface LinkState {
  version: 1;
  updatedAt: string;
  /** Capture id (hash of source line) -> date first seen. Dedup across runs. */
  seen: Record<string, string>;
}

export interface CaptureLinkDeps {
  rag: SweepRag;
  vault: VaultManager;
  notify?: NotifyPusher | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Top-level project folder of a note, or null if it is not a project note. */
function projectOf(file: string): string | null {
  const m = /^05-projects\/([^/]+)\//.exec(file);
  return m ? m[1] : null;
}

/** Strip the inbox bullet prefix ("- HH:MM · ") down to the semantic text. */
function captureText(line: string): string {
  return line
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^\d{1,2}:\d{2}\s*[·:.-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class CaptureLinkSweepService {
  private running: Promise<CaptureLinkResult> | null = null;

  constructor(private readonly deps: CaptureLinkDeps) {}

  private threshold(): number {
    const n = Number(process.env.CAPTURE_LINK_THRESHOLD);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_THRESHOLD;
  }

  /** Single-flight (cron and boot runs share one execution). */
  async runSweep(): Promise<CaptureLinkResult> {
    if (this.running) return this.running;
    this.running = this.doSweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doSweep(): Promise<CaptureLinkResult> {
    const { rag, vault } = this.deps;
    await rag.ensureReady();
    const state = await this.loadState();

    // 1. Read capture bullets from the inbox notes present in the index.
    const inboxFiles = new Set<string>();
    for (const chunk of rag.embeddedChunks) {
      if (chunk.file.startsWith(INBOX_PREFIX)) inboxFiles.add(chunk.file);
    }
    const captures: Array<{ id: string; text: string; file: string }> = [];
    for (const file of inboxFiles) {
      let content: string;
      try {
        content = await vault.readFile(file);
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        if (!/^\s*[-*]\s/.test(line)) continue;
        const text = captureText(line);
        if (text.length < 8) continue; // skip empty markers / bare separators
        captures.push({ id: sha(`${file}::${line.trim()}`), text, file });
      }
    }

    const fresh = captures.filter(c => !state.seen[c.id]).slice(0, MAX_CAPTURES_PER_RUN);

    // 2. Group project chunks by top-level project key.
    const projectChunks = new Map<string, EmbeddedChunk[]>();
    for (const chunk of rag.embeddedChunks) {
      const p = projectOf(chunk.file);
      if (!p) continue;
      const list = projectChunks.get(p) ?? [];
      list.push(chunk);
      projectChunks.set(p, list);
    }

    // 3. Embed fresh captures, match each to its best project.
    const proposals: string[] = [];
    if (fresh.length > 0 && projectChunks.size > 0) {
      const vectors = await rag.embedQueries(fresh.map(c => c.text));
      const threshold = this.threshold();
      fresh.forEach((cap, i) => {
        const vec = vectors[i];
        let bestProject = '';
        let bestScore = 0;
        for (const [project, chunks] of projectChunks) {
          let s = 0;
          for (const chunk of chunks) s = Math.max(s, dot(vec, chunk.embedding));
          if (s > bestScore) {
            bestScore = s;
            bestProject = project;
          }
        }
        state.seen[cap.id] = todayIso();
        if (bestScore >= threshold && bestProject) {
          const short = cap.text.length > 90 ? `${cap.text.slice(0, 90)}...` : cap.text;
          proposals.push(
            `- La capture « ${short} » pourrait servir **${bestProject}** (score ${bestScore.toFixed(2)}). ` +
              `Évalue le coup concret : [[${PROJECT_PREFIX}${bestProject}/_index]].`,
          );
        }
      });
    } else {
      for (const c of fresh) state.seen[c.id] = todayIso();
    }

    if (proposals.length > 0) {
      await this.appendProposals(proposals);
      if (this.deps.notify) {
        const first = proposals[0].replace(/\[\[|\]\]|\*\*/g, '').replace(/^-\s*/, '');
        await this.deps.notify.push({
          title: 'Cerveau : captures qui servent',
          message: `${proposals.length} capture(s) reliée(s) à un projet.\n${first}\nDétail : 08-auto/_captures-liens.md`,
          priority: 3,
          tags: ['brain'],
        });
      }
    }

    if (fresh.length > 0) {
      state.updatedAt = new Date().toISOString();
      await this.saveState(state);
    }

    const result: CaptureLinkResult = {
      captures: captures.length,
      newCaptures: fresh.length,
      projects: projectChunks.size,
      proposals: proposals.length,
    };
    logger.info('Capture link sweep done', { ...result });
    return result;
  }

  private async loadState(): Promise<LinkState> {
    const empty: LinkState = { version: 1, updatedAt: '', seen: {} };
    try {
      const raw = await this.deps.vault.readFile(STATE_FILE);
      const parsed = JSON.parse(raw) as Partial<LinkState>;
      return { ...empty, ...parsed, seen: parsed.seen ?? {} };
    } catch {
      return empty; // first run or unreadable: start clean
    }
  }

  private async saveState(state: LinkState): Promise<void> {
    await this.deps.vault.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private async appendProposals(proposals: string[]): Promise<void> {
    const { vault } = this.deps;
    const header = [
      '---',
      'type: note',
      'tags: [auto, captures]',
      '---',
      '',
      '# Captures qui servent (auto)',
      '',
      '> Généré par le serveur (propose-only). Chaque capture est reliée au projet',
      "> qu'elle pourrait faire avancer. Le lien vient des embeddings ; le coup",
      "> concret se décide à la main ou via l'agent quotidien (section F2).",
      '',
    ].join('\n');

    let body = '';
    try {
      const existing = await vault.readFile(PROPOSALS_FILE);
      const idx = existing.indexOf('\n## ');
      body = idx >= 0 ? existing.slice(idx) : '';
    } catch {
      body = '';
    }

    const lines = [`\n## ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`, '', ...proposals, ''];
    const merged = lines.join('\n') + body;
    const sections = merged.split(/\n(?=## )/).slice(0, MAX_PROPOSAL_SECTIONS);
    await vault.writeFile(PROPOSALS_FILE, header + sections.join('\n'));
  }
}
