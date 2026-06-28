import type { RagService } from '@/services/rag/rag-service';
import type { SynapsesService } from '@/services/synapses/synapses-service';
import type { LearningService } from '@/services/learning/learning-service';
import type { LlmCompleter } from '@/services/synapses/types';
import type { VaultManager } from '@/services/vault-manager';
import type { ToolResponse } from '@/mcp/handlers/types';
import { SettingsBackedCompleter, hasChatProvider } from '@/services/llm/settings-completer';
import { getSettingsStore } from '@/services/settings/settings-store';
import { logger } from '@/utils/logger';

// --- quarantine layout ------------------------------------------------------
// Everything the autonomous loop produces lands here and ONLY here. Nothing it
// writes ever touches the curated vault — it is propose-only by construction.
const AUTO_DIR = '08-auto';
const AGENDA_FILE = `${AUTO_DIR}/_agenda.md`; // standing backlog (cross-cycle memory)
const LOG_FILE = `${AUTO_DIR}/_cognition-log.md`; // append-only ledger of every cycle
const INBOX_FILE = `${AUTO_DIR}/_inbox-darius.md`; // current snapshot for the human
const PRIORITIES_FILE = `${AUTO_DIR}/_priorities.md`; // optional, user-edited compass

const DEFAULT_MAX_ITEMS = 2;
const MAX_ITEMS_CAP = 5;
const MAX_AGENDA = 20;
const PRIOR_EXCERPT = 1800;

type Kind = 'gap' | 'link' | 'coherence' | 'theme' | 'synthesis' | 'other';
type Verdict = 'solid' | 'weak' | 'rejected' | 'needs_human';

interface AgendaItem {
  question: string;
  why: string;
  value: number; // 0..1 expected payoff
  kind: Kind;
}

interface Finding {
  item: AgendaItem;
  answer: string;
  citations: string[];
  verdict: Verdict;
  confidence: number; // 0..1
  critique: string;
}

export interface ReflectionResult {
  date: string;
  processed: number;
  findings: Finding[];
  carried: AgendaItem[];
  reflectionFile: string;
}

export interface ReflectionDeps {
  rag: RagService;
  synapses: SynapsesService;
  learning: LearningService;
  vault: VaultManager;
  llm: LlmCompleter;
}

interface Signal {
  themes: unknown[];
  gaps: unknown[];
  links: unknown[];
  coherence: unknown[];
  priorAgenda: string;
  priorities: string;
}

/**
 * The autonomous "level 3" loop: the cerveau sets its OWN agenda, reasons over
 * the vault, then adversarially critiques itself — once per scheduled cycle.
 *
 * Propose-only: every artefact is written under `08-auto/` (quarantine) and the
 * loop never edits curated notes. The correction loop closes on the human (the
 * inbox digest) and on reality, not on pure self-judgement. Memory persists in
 * the agenda + cognition log so a cycle builds on the previous one.
 */
export class ReflectionService {
  constructor(private readonly deps: ReflectionDeps) {}

  private maxItems(): number {
    const n = Number(process.env.REFLECTION_MAX_ITEMS);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ITEMS;
    return Math.min(Math.floor(n), MAX_ITEMS_CAP);
  }

  /** One full propose-only cognition cycle. Writes only under `08-auto/`. */
  async runCycle(): Promise<ReflectionResult> {
    const { rag, synapses, learning, vault, llm } = this.deps;
    await rag.ensureReady();
    const date = new Date().toISOString().slice(0, 10);
    await this.ensureDir();

    // 1. PERCEIVE — current signal (existing analyses) + memory.
    const [themes, gaps, links, coherence] = await Promise.all([
      synapses.findThemes({}),
      learning.findGaps(),
      synapses.suggestLinks({ top_k: 8 }),
      synapses.auditCoherence({}),
    ]);
    const signal: Signal = {
      themes: arr(themes, 'themes'),
      gaps: arr(gaps, 'gaps'),
      links: arr(links, 'suggestions'),
      coherence: arr(coherence, 'issues'),
      priorAgenda: trunc(await this.readOptional(AGENDA_FILE), PRIOR_EXCERPT),
      priorities: trunc(await this.readOptional(PRIORITIES_FILE), PRIOR_EXCERPT),
    };

    // 2. REFLECT — the cerveau chooses its own agenda.
    const agenda = await this.reflect(llm, signal);
    if (agenda.length === 0) {
      logger.info('Reflection: empty agenda, nothing worth investigating');
      await this.appendLog(date, []);
      return { date, processed: 0, findings: [], carried: [], reflectionFile: '' };
    }

    // 3. SELECT — respect the per-cycle budget; the rest is carried forward.
    const max = this.maxItems();
    const selected = agenda.slice(0, max);
    const carried = agenda.slice(max);

    // 4 + 5. THINK then CRITIQUE each selected item.
    const findings: Finding[] = [];
    for (const item of selected) {
      try {
        findings.push(await this.investigate(item));
      } catch (error) {
        logger.error('Reflection: investigation failed', {
          q: item.question,
          error: String(error),
        });
      }
    }

    // 6. WRITE — quarantine only.
    const nextAgenda = buildNextAgenda(carried, findings);
    const reflectionFile = `${AUTO_DIR}/reflection-${date}.md`;
    await vault.writeFile(reflectionFile, renderReflection(date, findings, carried));
    await vault.writeFile(AGENDA_FILE, renderAgenda(date, nextAgenda));
    await vault.writeFile(INBOX_FILE, renderInbox(date, findings, nextAgenda));
    await this.appendLog(date, findings);

    logger.info('Reflection cycle done', { date, processed: findings.length });
    return { date, processed: findings.length, findings, carried, reflectionFile };
  }

  // --- steps ---------------------------------------------------------------

  private async reflect(llm: LlmCompleter, signal: Signal): Promise<AgendaItem[]> {
    const raw = await llm.complete(REFLECT_SYSTEM, renderSignal(signal), 2000);
    return parseJsonArray<Partial<AgendaItem>>(raw)
      .filter(a => a && typeof a.question === 'string' && a.question.trim())
      .map(a => ({
        question: String(a.question).trim(),
        why: String(a.why ?? '').trim(),
        value: clamp01(a.value),
        kind: normalizeKind(a.kind),
      }))
      .sort((x, y) => y.value - x.value)
      .slice(0, MAX_AGENDA);
  }

  private async investigate(item: AgendaItem): Promise<Finding> {
    const { rag, llm } = this.deps;
    const asked = await rag.askCerveau({ question: item.question });
    const d = asked.success ? (asked.data as Record<string, unknown>) : null;
    const answer = String((d?.answer as string) ?? '').trim();
    const citations = extractCitations(d?.citations);

    // CRITIQUE — adversarial pass. Default to skepticism.
    const raw = await llm.complete(
      CRITIC_SYSTEM,
      `Question :\n${item.question}\n\nRéponse produite par le cerveau :\n${answer || '(vide)'}\n\n` +
        `Sources citées :\n${citations.join('\n') || '(aucune)'}`,
      800,
    );
    const v = parseJsonObject<{ verdict?: string; confidence?: number; critique?: string }>(raw);
    return {
      item,
      answer,
      citations,
      verdict: normalizeVerdict(v?.verdict),
      confidence: clamp01(v?.confidence),
      critique: String(v?.critique ?? '').trim(),
    };
  }

  // --- io helpers ----------------------------------------------------------

  private async ensureDir(): Promise<void> {
    try {
      await this.deps.vault.createDirectory(AUTO_DIR, true);
    } catch {
      /* directory may already exist */
    }
  }

  private async readOptional(file: string): Promise<string> {
    try {
      if (await this.deps.vault.fileExists(file)) return await this.deps.vault.readFile(file);
    } catch {
      /* ignore */
    }
    return '';
  }

  private async appendLog(date: string, findings: Finding[]): Promise<void> {
    const prior = (await this.readOptional(LOG_FILE)).trimEnd();
    const base = prior || logHeader();
    const rows = findings.length
      ? findings
          .map(f => `| ${date} | ${cell(f.item.question)} | ${f.verdict} | ${f.confidence} |`)
          .join('\n')
      : `| ${date} | _(rien d'assez rentable à traiter)_ | — | — |`;
    await this.deps.vault.writeFile(LOG_FILE, `${base}\n${rows}\n`);
  }
}

/** Build the loop, or `null` when no LLM provider is configured. */
export function createReflectionService(
  rag: RagService,
  synapses: SynapsesService,
  learning: LearningService,
  vault: VaultManager,
): ReflectionService | null {
  if (!hasChatProvider()) return null;
  return new ReflectionService({
    rag,
    synapses,
    learning,
    vault,
    llm: new SettingsBackedCompleter(getSettingsStore()),
  });
}

// --- prompts ----------------------------------------------------------------

const REFLECT_SYSTEM = [
  "Tu es la part réflexive d'un « deuxième cerveau » (notes Markdown de Darius).",
  "On te donne l'état courant : thèmes, lacunes, liens manquants, incohérences, ton agenda précédent, et les priorités de Darius.",
  'Choisis les questions les plus RENTABLES à approfondir maintenant : celles qui font avancer les projets actifs de Darius, comblent une vraie lacune, ou relient des îlots de connaissance.',
  'Ancre-toi sur les priorités. Pénalise la nouveauté gratuite et les sujets déjà tranchés. Mieux vaut une bonne question qu’une réponse creuse.',
  'Pour chaque sujet : "question" (ce qu’il faut creuser, formulé comme une vraie question), "why" (pourquoi ça compte pour Darius), "value" (0 à 1, rentabilité attendue), "kind" (gap|link|coherence|theme|synthesis|other).',
  'Réponds UNIQUEMENT avec un tableau JSON classé par value décroissante, max 6 objets :',
  '[{"question":"…","why":"…","value":0.8,"kind":"gap"}]',
].join('\n');

const CRITIC_SYSTEM = [
  'Tu es un CRITIQUE ADVERSE. On te donne une question, une réponse produite par le cerveau, et ses sources.',
  'Ta mission : réfuter. La réponse est-elle réellement soutenue par les sources du vault, ou est-ce du bluff, de la généralité, ou une invention ?',
  'Par défaut, sois sceptique. Choisis un verdict :',
  '- "solid" : soutenu par les sources et réellement utile.',
  '- "weak" : vague, peu soutenu, ou évident.',
  '- "rejected" : faux, non soutenu, ou hors-sujet.',
  '- "needs_human" : nécessite une décision ou une information que seul Darius a.',
  'Réponds UNIQUEMENT en JSON : {"verdict":"…","confidence":0.6,"critique":"… (1-2 phrases)"}',
].join('\n');

// --- rendering --------------------------------------------------------------

function renderSignal(s: Signal): string {
  const block: string[] = [];
  block.push('PRIORITÉS DE DARIUS :', s.priorities || '(non définies — déduis-les des projets actifs)', '');
  block.push('AGENDA PRÉCÉDENT :', s.priorAgenda || '(vide)', '');
  block.push(`THÈMES (${s.themes.length}) :`);
  for (const t of s.themes.slice(0, 10)) {
    const o = t as Record<string, unknown>;
    block.push(`- ${str(o.name)} : ${str(o.summary)}`);
  }
  block.push('', `LACUNES (${s.gaps.length}) :`);
  for (const g of s.gaps.slice(0, 10)) {
    const o = g as Record<string, unknown>;
    block.push(`- ${str(o.topic)} : ${str(o.reason)} → ${str(o.suggestion)}`);
  }
  block.push('', `LIENS MANQUANTS (${s.links.length}) :`);
  for (const l of s.links.slice(0, 10)) {
    const o = l as Record<string, unknown>;
    block.push(`- ${base(str(o.a))} ⇄ ${base(str(o.b))} : ${str(o.liaison) || str(o.reason)}`);
  }
  block.push('', `INCOHÉRENCES (${s.coherence.length}) :`);
  for (const c of s.coherence.slice(0, 10)) {
    const o = c as Record<string, unknown>;
    block.push(`- ${str(o.type)} ${base(str(o.a))}/${base(str(o.b))} : ${str(o.explanation)}`);
  }
  return block.join('\n');
}

function renderReflection(date: string, findings: Finding[], carried: AgendaItem[]): string {
  const out: string[] = [];
  out.push('---', 'type: reflection', 'tags: [auto, reflection]', 'source: auto', 'status: proposed', `date: ${date}`, '---', '');
  out.push(`# 🧠 Réflexion autonome — ${date}`, '');
  out.push("> Propose-only. Généré par le cerveau lui-même. Rien n'a été modifié dans tes notes curées. À valider avant toute promotion.", '');

  out.push('## Sujets approfondis');
  if (findings.length === 0) out.push("- _Rien d'assez rentable à creuser cette fois._");
  for (const f of findings) {
    out.push('', `### ${f.item.question}`);
    if (f.item.why) out.push(`- **Pourquoi** : ${f.item.why}`);
    out.push(`- **Piste** : ${f.answer || '_(le cerveau n’a rien trouvé de solide)_'}`);
    if (f.citations.length) out.push(`- **Sources** : ${f.citations.map(c => `[[${base(c)}]]`).join(' · ')}`);
    out.push(`- **Auto-critique** : \`${f.verdict}\` (confiance ${f.confidence}) — ${f.critique || '—'}`);
  }
  out.push('');

  out.push('## Reporté (agenda)');
  if (carried.length === 0) out.push('- _Rien en attente._');
  for (const a of carried) out.push(`- ${a.question} — ${a.why} _(valeur ${a.value})_`);
  out.push('');
  return out.join('\n');
}

function renderInbox(date: string, findings: Finding[], agenda: AgendaItem[]): string {
  const solid = findings.filter(f => f.verdict === 'solid');
  const ask = findings.filter(f => f.verdict === 'needs_human');
  const out: string[] = [];
  out.push('---', 'type: hub', 'tags: [auto, inbox, hub]', `updated: ${date}`, '---', '');
  out.push('# 📥 Inbox cerveau → Darius', '');
  out.push(`> Mis à jour le ${date}. Ce que le cerveau a trouvé tout seul. Valide, rejette ou redirige (édite \`_priorities.md\` pour l’orienter).`, '');

  out.push('## ✅ À valider (solide)');
  if (solid.length === 0) out.push('- _Rien de solide à te soumettre cette fois._');
  for (const f of solid)
    out.push(`- **${f.item.question}** — ${oneLine(f.answer)} _(confiance ${f.confidence})_ → [[reflection-${date}]]`);
  out.push('');

  out.push('## ❓ Ton avis demandé');
  if (ask.length === 0) out.push('- _Aucune question bloquante._');
  for (const f of ask) out.push(`- **${f.item.question}** — ${f.critique || f.item.why}`);
  out.push('');

  out.push('## 🗓️ Prochains sujets (agenda)');
  if (agenda.length === 0) out.push('- _Agenda vide._');
  for (const a of agenda.slice(0, 8)) out.push(`- ${a.question} _(valeur ${a.value})_`);
  out.push('');
  return out.join('\n');
}

function renderAgenda(date: string, agenda: AgendaItem[]): string {
  const out: string[] = [];
  out.push('---', 'type: agenda', 'tags: [auto, agenda]', `updated: ${date}`, '---', '');
  out.push('# 🗂️ Agenda de réflexion (auto)', '');
  out.push("> File d'attente que le cerveau se donne à lui-même. Édite `_priorities.md` pour l'orienter.", '');
  if (agenda.length === 0) out.push('- _Vide._');
  for (const a of agenda) out.push(`- [ ] ${a.question} — ${a.why} _(valeur ${a.value}, ${a.kind})_`);
  out.push('');
  return out.join('\n');
}

function logHeader(): string {
  return [
    '---',
    'type: log',
    'tags: [auto, log]',
    '---',
    '',
    '# 🧾 Journal de cognition',
    '',
    '| Date | Sujet | Verdict | Confiance |',
    '|------|-------|---------|-----------|',
  ].join('\n');
}

// --- agenda memory ----------------------------------------------------------

/** Next cycle's backlog: carried items + items the critic flagged weak / needs_human. */
function buildNextAgenda(carried: AgendaItem[], findings: Finding[]): AgendaItem[] {
  const revisit: AgendaItem[] = findings
    .filter(f => f.verdict === 'weak' || f.verdict === 'needs_human')
    .map(f => ({
      question: f.item.question,
      why: f.critique || f.item.why,
      value: f.item.value,
      kind: f.item.kind,
    }));
  const seen = new Set<string>();
  const merged: AgendaItem[] = [];
  for (const a of [...carried, ...revisit]) {
    const key = a.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(a);
  }
  return merged.slice(0, MAX_AGENDA);
}

// --- helpers ----------------------------------------------------------------

function arr(r: ToolResponse, key: string): unknown[] {
  if (!r.success || !r.data) return [];
  const v = (r.data as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

function extractCitations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const c of value) {
    if (typeof c === 'string') out.push(c);
    else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      const s = o.file ?? o.path ?? o.title ?? o.source;
      if (typeof s === 'string') out.push(s);
    }
    if (out.length >= 8) break;
  }
  return [...new Set(out)];
}

function normalizeKind(value: unknown): Kind {
  const k = String(value ?? '').toLowerCase();
  return (['gap', 'link', 'coherence', 'theme', 'synthesis'] as const).includes(k as never)
    ? (k as Kind)
    : 'other';
}

function normalizeVerdict(value: unknown): Verdict {
  const v = String(value ?? '').toLowerCase();
  return (['solid', 'weak', 'rejected', 'needs_human'] as const).includes(v as never)
    ? (v as Verdict)
    : 'weak';
}

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function base(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.md$/i, '');
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 180 ? `${t.slice(0, 180)}…` : t;
}

function cell(text: string): string {
  return oneLine(text).replace(/\|/g, '/').slice(0, 100);
}

function trunc(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseJsonArray<T>(text: string): T[] {
  if (!text) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(text: string): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
