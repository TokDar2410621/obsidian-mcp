import crypto from 'crypto';
import type { VaultManager } from '@/services/vault-manager';
import type { EmbeddedChunk } from '@/services/rag/types';
import { dot } from '@/services/rag/cosine';
import { logger } from '@/utils/logger';

// --- quarantine layout ------------------------------------------------------
// Deterministic objective sweep. Propose-only: like the reflection loop, this
// service writes ONLY under `08-auto/`. It never ticks a condition and never
// touches an objective note — it detects candidate matches and deadline events
// and stages them for a human (or an interactive agent with proof) to act on.
const AUTO_DIR = '08-auto';
const STATE_FILE = `${AUTO_DIR}/_objectifs-sweep.json`;
const PROPOSALS_FILE = `${AUTO_DIR}/_objectifs-propositions.md`;

const DEFAULT_MATCH_THRESHOLD = 0.45; // cosine, tune with OBJECTIVE_MATCH_THRESHOLD
const DEADLINE_WARN_DAYS = 7;
const MAX_PROPOSAL_SECTIONS = 30; // proposals file rotation (sections kept)

/** Vault folders that can never be a matching source (quarantine, templates, generated). */
const EXCLUDED_PREFIXES = ['08-auto/', '_templates/', '99-graphify-out/'];

// --- shapes -------------------------------------------------------------------

/** The slice of RagService the sweep needs (structural, so tests can fake it). */
export interface SweepRag {
  ensureReady(): Promise<void>;
  readonly embeddedChunks: readonly EmbeddedChunk[];
  /** Embed short query texts, L2-normalised (added on RagService for this service). */
  embedQueries(texts: string[]): Promise<Float32Array[]>;
}

export interface ObjectiveCondition {
  name: string;
  criteria: string;
  done: boolean;
}

export interface ObjectiveNote {
  file: string;
  title: string;
  statut: string;
  echeance: string | null; // YYYY-MM-DD
  conditions: ObjectiveCondition[];
}

export interface SweepResult {
  objectives: number;
  openConditions: number;
  changedFiles: number;
  proposals: number;
  deadlineAlerts: number;
}

interface SweepState {
  version: 1;
  updatedAt: string;
  /** Per-source-file content hash (from index chunk hashes) at last sweep. */
  fileHashes: Record<string, string>;
  /** Proposal keys already emitted (objective::condition::source) -> date. */
  proposed: Record<string, string>;
  /** Deadline alert keys already emitted (objective::kind::bucket) -> date. */
  deadlineAlerts: Record<string, string>;
}

export interface ObjectiveSweepDeps {
  rag: SweepRag;
  vault: VaultManager;
}

// --- parsing ------------------------------------------------------------------

/** Tolerant line-based frontmatter reader (no YAML dependency needed). */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
  }
  return fields;
}

/**
 * Extract checkbox conditions from an objective body. Convention (AGENTS.md):
 * `- [ ] **Name** : criteres : <exact criteria>. Preuve : ...`
 * Tolerates accents (critères), `*` bullets and missing criteria labels.
 */
export function parseConditions(content: string): ObjectiveCondition[] {
  const conditions: ObjectiveCondition[] = [];
  for (const line of content.split(/\r?\n/)) {
    const box = /^\s*[-*]\s*\[( |x|X)\]\s*\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(line);
    if (!box) continue;
    const done = box[1].toLowerCase() === 'x';
    const rest = box[3] ?? '';
    const crit = /crit[eè]res?\s*:\s*([\s\S]*?)(?:\.?\s*Preuve\s*:|$)/i.exec(rest);
    const criteria = (crit ? crit[1] : rest).trim();
    conditions.push({ name: box[2].trim(), criteria, done });
  }
  return conditions;
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

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function isExcluded(file: string): boolean {
  return EXCLUDED_PREFIXES.some(p => file.startsWith(p)) || file.startsWith('_');
}

// --- service ------------------------------------------------------------------

/**
 * Closes the vault's open loops deterministically. On each run it:
 *  1. finds open objective notes (frontmatter `type: objectif`, `statut: ouvert`
 *     or `en-retard`) via the RAG index (tag or filename), reads and parses them;
 *  2. diffs the index against its last-seen file hashes to find NEW/CHANGED
 *     source notes (everything outside `08-auto/`, `_templates/`, generated);
 *  3. embeds each unmet condition's criteria and cosine-matches them against
 *     the changed notes' existing chunk embeddings (no re-embedding of notes);
 *  4. stages match PROPOSALS and deadline alerts under `08-auto/` — dedup'd via
 *     a state file so webhook-triggered runs never spam.
 * Ticking a condition stays a human/agent act with cited proof (AGENTS.md).
 */
export class ObjectiveSweepService {
  private sweepPromise: Promise<SweepResult> | null = null;

  constructor(private readonly deps: ObjectiveSweepDeps) {}

  private threshold(): number {
    const n = Number(process.env.OBJECTIVE_MATCH_THRESHOLD);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_MATCH_THRESHOLD;
  }

  /** Single-flight sweep (webhook bursts and the cron share one run). */
  async runSweep(): Promise<SweepResult> {
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this.doSweep().finally(() => {
      this.sweepPromise = null;
    });
    return this.sweepPromise;
  }

  private async doSweep(): Promise<SweepResult> {
    const { rag } = this.deps;
    await rag.ensureReady();

    const state = await this.loadState();
    const objectives = await this.loadObjectives();
    const open = objectives.filter(o => o.statut === 'ouvert' || o.statut === 'en-retard');
    const openConditions = open.flatMap(o =>
      o.conditions.filter(c => !c.done).map(c => ({ objective: o, condition: c })),
    );

    // Diff the index against last-seen hashes -> new/changed source notes.
    const currentHashes = this.fileHashesFromIndex();
    const changed: string[] = [];
    for (const [file, hash] of Object.entries(currentHashes)) {
      if (state.fileHashes[file] !== hash) changed.push(file);
    }

    const proposals: string[] = [];
    if (changed.length > 0 && openConditions.length > 0) {
      const vectors = await rag.embedQueries(
        openConditions.map(x => `${x.condition.name}. ${x.condition.criteria}`),
      );
      const byFile = this.chunksByFile(changed);
      const threshold = this.threshold();

      openConditions.forEach((entry, i) => {
        const vec = vectors[i];
        for (const [file, chunks] of byFile) {
          if (file === entry.objective.file) continue;
          let best = 0;
          for (const chunk of chunks) best = Math.max(best, dot(vec, chunk.embedding));
          if (best < threshold) continue;
          const key = `${entry.objective.file}::${sha(entry.condition.name)}::${file}`;
          if (state.proposed[key]) continue;
          state.proposed[key] = todayIso();
          proposals.push(
            `- **${entry.objective.title}** : la note [[${file.replace(/\.md$/, '')}]] semble concerner la condition ` +
              `« ${entry.condition.name} » (score ${best.toFixed(2)}). Vérifier les critères puis cocher avec preuve, ou ignorer.`,
          );
        }
      });
    }

    // Deadline pass (independent of note changes).
    const alerts: string[] = [];
    for (const objective of open) {
      if (!objective.echeance) continue;
      const remainingConditions = objective.conditions.filter(c => !c.done).length;
      if (remainingConditions === 0) continue;
      const days = daysUntil(objective.echeance);
      const link = `[[${objective.file.replace(/\.md$/, '')}]]`;
      if (days < 0) {
        const key = `${objective.file}::overdue::${todayIso()}`;
        if (!state.deadlineAlerts[key]) {
          state.deadlineAlerts[key] = todayIso();
          alerts.push(
            `- 🔴 **${objective.title}** : échéance ${objective.echeance} DÉPASSÉE, ` +
              `${remainingConditions} condition(s) ouverte(s) — ${link}. Proposition : passer \`statut: en-retard\`.`,
          );
        }
      } else if (days <= DEADLINE_WARN_DAYS) {
        const key = `${objective.file}::soon::${todayIso()}`;
        if (!state.deadlineAlerts[key]) {
          state.deadlineAlerts[key] = todayIso();
          alerts.push(
            `- 🟠 **${objective.title}** : échéance ${objective.echeance} dans ${days} jour(s), ` +
              `${remainingConditions} condition(s) ouverte(s) — ${link}.`,
          );
        }
      }
    }

    const dirty =
      proposals.length > 0 || alerts.length > 0 || this.hashesChanged(state.fileHashes, currentHashes);
    state.fileHashes = currentHashes;

    if (proposals.length > 0 || alerts.length > 0) {
      await this.appendProposals(proposals, alerts);
    }
    if (dirty) {
      state.updatedAt = new Date().toISOString();
      await this.saveState(state);
    }

    const result: SweepResult = {
      objectives: open.length,
      openConditions: openConditions.length,
      changedFiles: changed.length,
      proposals: proposals.length,
      deadlineAlerts: alerts.length,
    };
    logger.info('Objective sweep done', { ...result });
    return result;
  }

  // --- objectives discovery ---------------------------------------------------

  private async loadObjectives(): Promise<ObjectiveNote[]> {
    const { rag, vault } = this.deps;
    const candidates = new Set<string>();
    for (const chunk of rag.embeddedChunks) {
      if (chunk.tags.some(t => t.toLowerCase() === 'objectif')) candidates.add(chunk.file);
      else if (/(^|\/)objectif[^/]*\.md$/i.test(chunk.file)) candidates.add(chunk.file);
    }

    const objectives: ObjectiveNote[] = [];
    for (const file of candidates) {
      if (file.startsWith('_templates/')) continue;
      let content: string;
      try {
        content = await vault.readFile(file);
      } catch {
        continue;
      }
      const fm = parseFrontmatter(content);
      if ((fm.type || '').toLowerCase() !== 'objectif') continue;
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || file;
      objectives.push({
        file,
        title,
        statut: (fm.statut || 'ouvert').toLowerCase(),
        echeance: /^\d{4}-\d{2}-\d{2}$/.test(fm.echeance || '') ? fm.echeance : null,
        conditions: parseConditions(content),
      });
    }
    return objectives;
  }

  // --- index views --------------------------------------------------------------

  private fileHashesFromIndex(): Record<string, string> {
    const perFile = new Map<string, string[]>();
    for (const chunk of this.deps.rag.embeddedChunks) {
      if (isExcluded(chunk.file)) continue;
      const list = perFile.get(chunk.file) ?? [];
      list.push(chunk.hash);
      perFile.set(chunk.file, list);
    }
    const hashes: Record<string, string> = {};
    for (const [file, list] of perFile) hashes[file] = sha(list.sort().join('|'));
    return hashes;
  }

  private chunksByFile(files: string[]): Map<string, EmbeddedChunk[]> {
    const wanted = new Set(files);
    const map = new Map<string, EmbeddedChunk[]>();
    for (const chunk of this.deps.rag.embeddedChunks) {
      if (!wanted.has(chunk.file)) continue;
      const list = map.get(chunk.file) ?? [];
      list.push(chunk);
      map.set(chunk.file, list);
    }
    return map;
  }

  private hashesChanged(prev: Record<string, string>, next: Record<string, string>): boolean {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    if (prevKeys.length !== nextKeys.length) return true;
    for (const key of nextKeys) if (prev[key] !== next[key]) return true;
    return false;
  }

  // --- persistence ---------------------------------------------------------------

  private async loadState(): Promise<SweepState> {
    const empty: SweepState = {
      version: 1,
      updatedAt: '',
      fileHashes: {},
      proposed: {},
      deadlineAlerts: {},
    };
    try {
      const raw = await this.deps.vault.readFile(STATE_FILE);
      const parsed = JSON.parse(raw) as Partial<SweepState>;
      return {
        ...empty,
        ...parsed,
        fileHashes: parsed.fileHashes ?? {},
        proposed: parsed.proposed ?? {},
        deadlineAlerts: parsed.deadlineAlerts ?? {},
      };
    } catch {
      return empty; // first run, or unreadable state: start clean (dedup resets)
    }
  }

  private async saveState(state: SweepState): Promise<void> {
    await this.deps.vault.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private async appendProposals(proposals: string[], alerts: string[]): Promise<void> {
    const { vault } = this.deps;
    const header = [
      '---',
      'type: note',
      'tags: [auto, objectifs]',
      '---',
      '',
      '# 🎯 Objectifs — propositions du balayage (auto)',
      '',
      '> Généré par le serveur (propose-only). Vérifie les critères avant de cocher ;',
      '> une coche exige une preuve citée. Rien dans les notes objectifs n\'a été modifié.',
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

    const lines: string[] = [`\n## ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`, ''];
    if (alerts.length > 0) lines.push('### Échéances', ...alerts, '');
    if (proposals.length > 0) lines.push('### Coches candidates', ...proposals, '');

    // Rotate: keep the newest MAX_PROPOSAL_SECTIONS sections.
    const merged = lines.join('\n') + body;
    const sections = merged.split(/\n(?=## )/).slice(0, MAX_PROPOSAL_SECTIONS);
    await vault.writeFile(PROPOSALS_FILE, header + sections.join('\n'));
  }
}
