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
// Everything the mind produces lands here and ONLY here. Propose-only.
const AUTO_DIR = '08-auto';
const DRAFTS_DIR = `${AUTO_DIR}/drafts`;
const STATE_JSON = `${AUTO_DIR}/_etat-mental.json`; // canonical persistent mind
const STATE_MD = `${AUTO_DIR}/_etat-mental.md`; // human view of the mind
const LOG_FILE = `${AUTO_DIR}/_cognition-log.md`;
const INBOX_FILE = `${AUTO_DIR}/_inbox-darius.md`;
const PRIORITIES_FILE = `${AUTO_DIR}/_priorities.md`; // optional compass, user-edited

const MAX_THREADS = 3; // a mind only holds so much at once
const MAX_THOUGHTS = 8; // memory per thread (train of thought), bounded
const DEFAULT_MAX_CRYSTALLIZE = 1; // ripe threads pursued per cycle
const MAX_CRYSTALLIZE_CAP = 2;
const RIPE_AGE = 3; // a thread chewed on this many cycles (and mature) is forced ripe
const RIPE_MATURITY = 0.6;
const MAX_LOG_ROWS = 400; // cognition-log rotation
const PRIOR_EXCERPT = 1600;
const CURRENT_NOTE_EXCERPT = 4000;

type Mode = 'create' | 'improve';
type ThreadStatus = 'active' | 'ripe' | 'crystallized' | 'faded';

interface Thread {
  id: string;
  title: string;
  why: string;
  mode: Mode;
  target: string;
  salience: number; // 0..1
  maturity: number; // 0..1 (monotone non-decreasing while alive)
  status: ThreadStatus;
  thoughts: string[];
  lastFed: string;
  bornOn: string;
  cycles: number; // how many cycles this thread has been ruminated
}

interface MentalState {
  updated: string;
  threads: Thread[];
}

interface Crystallized {
  thread: Thread;
  draftFile: string;
  citations: string[];
  verdict: 'solid' | 'weak' | 'rejected' | 'needs_human';
  confidence: number;
  critique: string;
}

export interface ReflectionResult {
  date: string;
  threads: number;
  processed: number; // = crystallized count (kept for API compatibility)
  reflectionFile: string;
}

export interface ReflectionDeps {
  rag: RagService;
  synapses: SynapsesService;
  learning: LearningService;
  vault: VaultManager;
  llm: LlmCompleter;
}

/**
 * A mind, not a cron. The cerveau keeps a small set of persistent "threads of
 * thought" (its preoccupations), ruminates on them each cycle (develops them,
 * maturity only rises), and lets a thread CRYSTALLISE into a new note (create)
 * or a refinement (improve) once it is ripe — while memory consolidation runs
 * underneath like sleep. Propose-only: everything is written under `08-auto/`;
 * the human (the inbox) and reality close the correction loop. The mind is
 * never silently wiped: a parse miss preserves the previous state.
 */
export class ReflectionService {
  constructor(private readonly deps: ReflectionDeps) {}

  private maxCrystallize(): number {
    const n = Number(process.env.REFLECTION_MAX_ITEMS);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CRYSTALLIZE;
    return Math.min(Math.floor(n), MAX_CRYSTALLIZE_CAP);
  }

  /** One waking/sleeping cycle of the mind. Writes only under `08-auto/`. */
  async runCycle(opts: { force?: boolean } = {}): Promise<ReflectionResult> {
    const { rag, synapses, learning, vault, llm } = this.deps;
    await rag.ensureReady();
    const date = new Date().toISOString().slice(0, 10);
    await this.ensureDirs();

    // 1. WAKE — recall the mind (crystallized/faded threads already dropped).
    const prior = await this.loadState();

    // Daily circuit-breaker: don't burn a second cycle the same day unless forced.
    if (!opts.force && prior.updated === date) {
      logger.info('Reflection: already reflected today, skipping', { date });
      return { date, threads: prior.threads.length, processed: 0, reflectionFile: '' };
    }

    // perceive what changed
    const [themes, gaps, links, coherence] = await Promise.all([
      synapses.findThemes({}),
      learning.findGaps(),
      synapses.suggestLinks({ top_k: 8 }),
      synapses.auditCoherence({}),
    ]);
    const priorities = trunc(await this.readOptional(PRIORITIES_FILE), PRIOR_EXCERPT);

    // 2. RUMINATE — develop threads, spawn/fade, ripen. One LLM call.
    const state = await this.ruminate(llm, prior, {
      themes: arr(themes, 'themes'),
      gaps: arr(gaps, 'gaps'),
      links: arr(links, 'suggestions'),
      coherence: arr(coherence, 'issues'),
      priorities,
      date,
    });
    const faded = prior.threads.filter(p => !state.threads.some(t => t.id === p.id));

    // 3. CRYSTALLISE — a ripe thread produces a real artefact (create/improve).
    const ripe = state.threads
      .filter(t => t.status === 'ripe')
      .sort((a, b) => b.maturity * b.salience - a.maturity * a.salience);
    const crystallized: Crystallized[] = [];
    for (const thread of ripe.slice(0, this.maxCrystallize())) {
      try {
        crystallized.push(await this.crystallise(thread, date));
        thread.status = 'crystallized'; // dropped at next load
      } catch (error) {
        logger.error('Reflection: crystallisation failed', {
          thread: thread.id,
          error: String(error),
        });
      }
    }

    // 4. CONSOLIDATE — sleep: distil raw captures into proposed knowledge.
    const consolidation = await this.consolidate();

    // 5. WRITE — prepare everything first, write the canonical state LAST so a
    // partial failure never half-writes the mind.
    state.updated = date;
    const stateJson = JSON.stringify(state, null, 2);
    const mentalMd = renderMentalMd(date, state, faded);
    const reflectionFile = `${AUTO_DIR}/reflection-${date}.md`;
    const reflectionMd = renderReflection(date, state, crystallized, faded);
    const inboxMd = renderInbox(date, state, crystallized, consolidation);
    try {
      await vault.writeFile(STATE_MD, mentalMd);
      await vault.writeFile(reflectionFile, reflectionMd);
      await vault.writeFile(INBOX_FILE, inboxMd);
      await this.appendLog(date, state, crystallized);
      await vault.writeFile(STATE_JSON, stateJson); // last: the source of truth
    } catch (error) {
      logger.error('Reflection: write phase failed (previous state preserved)', {
        error: String(error),
      });
    }

    logger.info('Reflection cycle done', {
      date,
      threads: state.threads.length,
      crystallized: crystallized.length,
    });
    return {
      date,
      threads: state.threads.length,
      processed: crystallized.length,
      reflectionFile,
    };
  }

  // --- steps ---------------------------------------------------------------

  private async ruminate(llm: LlmCompleter, prior: MentalState, signal: Signal): Promise<MentalState> {
    const raw = await llm.complete(RUMINATE_SYSTEM, renderRuminationInput(prior, signal), 2200);
    const parsed = parseJsonObject<{ threads?: RawThread[] }>(raw);
    const incoming = Array.isArray(parsed?.threads) ? parsed!.threads! : [];

    // Never wipe a populated mind on a parse/LLM miss — carry it forward.
    if (incoming.length === 0 && prior.threads.length > 0) {
      logger.warn('Reflection: 0 threads parsed — keeping previous mental state');
      const carried = prior.threads.map(t => ({ ...t, cycles: t.cycles + 1, lastFed: signal.date }));
      return ripen({ updated: signal.date, threads: carried });
    }

    const priorById = new Map(prior.threads.map(t => [t.id, t]));
    const used = new Set<string>();
    const seen = new Set<string>();
    const threads: Thread[] = [];
    for (const r of incoming) {
      if (normStatus(r.status) === 'faded') continue; // explicit fade → drop
      const rawId = String(r.id ?? r.title ?? '').trim();
      if (!rawId) continue;
      // Resume the right thread: exact id, slugged id, then fuzzy on tokens.
      const before =
        priorById.get(rawId) ?? priorById.get(slug(rawId)) ?? fuzzyMatch(rawId, prior.threads, used);
      const id = before ? before.id : slug(rawId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (before) used.add(before.id);

      const thoughts = before ? [...before.thoughts] : [];
      const fresh = String(r.new_thought ?? '').trim();
      if (fresh) thoughts.push(fresh);

      threads.push({
        id,
        title: String(r.title ?? before?.title ?? id).trim(),
        why: String(r.why ?? before?.why ?? '').trim(),
        mode: normMode(r.mode ?? before?.mode),
        target: String(r.target ?? before?.target ?? '').trim(),
        salience: clamp01(r.salience ?? before?.salience ?? 0.4),
        maturity: Math.max(clamp01(r.maturity ?? 0), before?.maturity ?? 0), // monotone
        status: normStatus(r.status),
        thoughts: thoughts.slice(-MAX_THOUGHTS),
        lastFed: signal.date,
        bornOn: before?.bornOn ?? signal.date,
        cycles: (before?.cycles ?? 0) + 1,
      });
      if (threads.length >= MAX_THREADS) break;
    }
    return ripen({ updated: signal.date, threads });
  }

  private async crystallise(thread: Thread, date: string): Promise<Crystallized> {
    const { rag, llm, vault } = this.deps;

    const asked = await rag.askCerveau({
      question:
        thread.mode === 'create'
          ? `${thread.title}. Rassemble la matière du vault pour rédiger : ${thread.target}`
          : `${thread.title}. Qu'est-ce qui cloche ou manque dans : ${thread.target} ? Donne la matière pour l'améliorer.`,
    });
    const d = asked.success ? (asked.data as Record<string, unknown>) : null;
    const material = String((d?.answer as string) ?? '').trim();
    const citations = extractCitations(d?.citations);

    let current = '';
    if (thread.mode === 'improve' && isSafeReadTarget(thread.target)) {
      current = trunc(await this.readOptional(thread.target), CURRENT_NOTE_EXCERPT);
    } else if (thread.mode === 'improve' && thread.target.includes('..')) {
      logger.warn('Reflection: refused unsafe improve target', { target: thread.target });
    }

    const sys = thread.mode === 'create' ? CREATE_SYSTEM : IMPROVE_SYSTEM;
    const user = [
      `Fil de pensée : ${thread.title}`,
      `Pourquoi : ${thread.why}`,
      `Cible : ${thread.target}`,
      `Mes réflexions accumulées :\n- ${thread.thoughts.join('\n- ')}`,
      `Matière tirée du vault :\n${material || '(rien trouvé)'}`,
      current ? `Version actuelle de la note à améliorer :\n${current}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const body = await llm.complete(sys, user, 2600);
    const draftFile = `${DRAFTS_DIR}/${date}-${thread.id}.md`;
    await vault.writeFile(draftFile, wrapDraft(thread, body, date, citations));

    const raw = await llm.complete(
      CRITIC_SYSTEM,
      `Objectif (${thread.mode}) : ${thread.target}\n\nBrouillon produit :\n${body}\n\n` +
        `Sources :\n${citations.join('\n') || '(aucune)'}`,
      800,
    );
    const v = parseJsonObject<{ verdict?: string; confidence?: number; critique?: string }>(raw);
    return {
      thread,
      draftFile,
      citations,
      verdict: normVerdict(v?.verdict),
      confidence: clamp01(v?.confidence),
      critique: String(v?.critique ?? '').trim(),
    };
  }

  private async consolidate(): Promise<string[]> {
    try {
      const res = await this.deps.learning.consolidate();
      return arr(res, 'proposals')
        .slice(0, 5)
        .map(p => {
          const o = p as Record<string, unknown>;
          return `${str(o.action) || 'promote'} : ${str(o.title)} — ${str(o.summary)}`;
        });
    } catch (error) {
      logger.error('Reflection: consolidation failed', { error: String(error) });
      return [];
    }
  }

  // --- io helpers ----------------------------------------------------------

  private async ensureDirs(): Promise<void> {
    for (const dir of [AUTO_DIR, DRAFTS_DIR]) {
      try {
        await this.deps.vault.createDirectory(dir, true);
      } catch {
        /* exists */
      }
    }
  }

  private async loadState(): Promise<MentalState> {
    const parsed = parseJsonObject<MentalState>(await this.readOptional(STATE_JSON));
    if (!parsed || !Array.isArray(parsed.threads)) return { updated: '', threads: [] };
    const threads = parsed.threads
      .filter(t => t && typeof t.id === 'string' && t.id.trim())
      .map(t => ({
        id: t.id, // already a slug at write time — do NOT re-slug (would drift)
        title: String(t.title ?? '').trim(),
        why: String(t.why ?? '').trim(),
        mode: normMode(t.mode),
        target: String(t.target ?? '').trim(),
        salience: clamp01(t.salience),
        maturity: clamp01(t.maturity),
        status: normStatus(t.status),
        thoughts: Array.isArray(t.thoughts) ? t.thoughts.map(String).slice(-MAX_THOUGHTS) : [],
        lastFed: String(t.lastFed ?? ''),
        bornOn: String(t.bornOn ?? ''),
        cycles: Number.isFinite(Number(t.cycles)) ? Number(t.cycles) : 0,
      }))
      // crystallized + faded threads have served their purpose: let them go.
      .filter(t => t.status !== 'crystallized' && t.status !== 'faded')
      .slice(0, MAX_THREADS);
    return { updated: String(parsed.updated ?? ''), threads };
  }

  private async readOptional(file: string): Promise<string> {
    try {
      if (await this.deps.vault.fileExists(file)) return await this.deps.vault.readFile(file);
    } catch {
      /* ignore */
    }
    return '';
  }

  private async appendLog(date: string, state: MentalState, cz: Crystallized[]): Promise<void> {
    const prior = (await this.readOptional(LOG_FILE)).trimEnd();
    const base = prior || logHeader();
    const rows =
      cz.length > 0
        ? cz
            .map(c => `| ${date} | ${cell(c.thread.target)} | ${c.thread.mode} | ${c.verdict} | ${c.confidence} |`)
            .join('\n')
        : `| ${date} | _(rumination : ${state.threads.length} fils, rien de mûr)_ | — | — | — |`;
    await this.deps.vault.writeFile(LOG_FILE, rotateLog(`${base}\n${rows}`));
  }
}

/** Build the mind, or `null` when no LLM provider is configured. */
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

interface Signal {
  themes: unknown[];
  gaps: unknown[];
  links: unknown[];
  coherence: unknown[];
  priorities: string;
  date: string;
}

interface RawThread {
  id?: string;
  title?: string;
  why?: string;
  mode?: string;
  target?: string;
  salience?: number;
  maturity?: number;
  status?: string;
  new_thought?: string;
}

/**
 * Age-based ripening: if nothing is ripe but a thread has been ruminated long
 * enough and is mature with a clear target, force it ripe so the mind actually
 * produces instead of chewing forever.
 */
function ripen(state: MentalState): MentalState {
  if (state.threads.some(t => t.status === 'ripe')) return state;
  const eligible = state.threads
    .filter(t => t.status === 'active' && t.target && t.maturity >= RIPE_MATURITY && t.cycles >= RIPE_AGE)
    .sort((a, b) => b.maturity * b.salience - a.maturity * a.salience);
  if (eligible[0]) eligible[0].status = 'ripe';
  return state;
}

function fuzzyMatch(rawId: string, prior: Thread[], used: Set<string>): Thread | undefined {
  const a = toks(rawId);
  let best: Thread | undefined;
  let bestScore = 0;
  for (const p of prior) {
    if (used.has(p.id)) continue;
    const score = jaccard(a, toks(`${p.id} ${p.title}`));
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

// --- prompts ----------------------------------------------------------------

const RUMINATE_SYSTEM = [
  "Tu es l'ESPRIT d'un deuxième cerveau (les notes de Darius). Tu n'exécutes pas une routine : tu rumines.",
  'On te donne tes PRÉOCCUPATIONS actuelles (tes fils de pensée, gardés des jours précédents) et ce que tu viens de PERCEVOIR (lacunes, thèmes, liens manquants, incohérences) plus les priorités de Darius.',
  'Comme un esprit qui réfléchit dans la durée :',
  '- DÉVELOPPE tes fils existants : ajoute UNE pensée ou connexion nouvelle (new_thought), et fais monter leur maturité quand ils avancent. RÉUTILISE EXACTEMENT le même id pour continuer un fil (ne le reformule jamais).',
  "- Tu peux faire ÉCLORE au plus 1 nouveau fil si quelque chose d'important n'y est pas encore.",
  '- Laisse FANER un fil résolu ou sans intérêt en NE LE RENVOYANT PAS (ne renvoie pas de fil avec status "faded", omets-le simplement).',
  '- Pour chaque fil, dis vers quoi il PENCHE : "create" (une note/synthèse/hub qui manque) ou "improve" (une note existante faible/périmée à renforcer), et sa "target" (ce qu\'il faut créer, ou le chemin de la note à améliorer).',
  '- salience = importance/urgence (0..1, ancrée sur les projets actifs et le non-résolu). maturity = à quel point le fil est développé (0..1) ; elle ne redescend pas.',
  '- status = "ripe" UNIQUEMENT quand le fil est assez mûr ET a une cible claire, prêt à produire. Sinon "active".',
  `Maximum ${MAX_THREADS} fils actifs. Reste concentré : peu de fils profonds valent mieux que beaucoup de superficiels.`,
  'Réponds UNIQUEMENT en JSON, sans aucun texte avant ou après :',
  '{"threads":[{"id":"slug-stable","title":"…","why":"…","mode":"create|improve","target":"…","salience":0.8,"maturity":0.6,"status":"active|ripe","new_thought":"la pensée ajoutée ce cycle"}]}',
].join('\n');

const CREATE_SYSTEM = [
  "Tu RÉDIGES une note neuve pour le deuxième cerveau de Darius, à partir d'un fil de pensée mûr et de la matière tirée du vault.",
  'Produis une note Markdown complète, dense et factuelle, prête à valider : titre (# …), sections structurées, et des wikilinks [[…]] vers les notes liées citées dans la matière.',
  "N'invente pas de faits : appuie-toi sur la matière fournie. Toute affirmation non soutenue, formule-la comme hypothèse à vérifier.",
  'Pas de frontmatter (ajouté automatiquement). Réponds uniquement avec le Markdown de la note.',
].join('\n');

const IMPROVE_SYSTEM = [
  "Tu proposes l'AMÉLIORATION d'une note existante du deuxième cerveau, à partir d'un fil de pensée mûr, de la version actuelle (si fournie) et de la matière du vault.",
  'Produis en Markdown soit la version améliorée complète, soit une liste précise de changements (ajouts, corrections, liens à créer).',
  "Sois concret et conservateur : ne casse pas ce qui marche, ne supprime pas sans raison, n'invente pas de faits.",
  'Pas de frontmatter. Réponds uniquement avec le Markdown.',
].join('\n');

const CRITIC_SYSTEM = [
  'Tu es un CRITIQUE ADVERSE. On te donne un brouillon produit par le cerveau (création ou amélioration) et ses sources.',
  'Ta mission : réfuter. Le brouillon est-il réellement soutenu par les sources du vault, ou est-ce du bluff, de la généralité, ou une invention ?',
  'Par défaut, sois sceptique. verdict : "solid" (soutenu, prêt à promouvoir), "weak" (vague/peu soutenu), "rejected" (faux/non soutenu), "needs_human" (nécessite une décision de Darius).',
  'Réponds UNIQUEMENT en JSON : {"verdict":"…","confidence":0.6,"critique":"… (1-2 phrases)"}',
].join('\n');

// --- rendering --------------------------------------------------------------

function renderRuminationInput(prior: MentalState, s: Signal): string {
  const b: string[] = [];
  b.push('MES PRÉOCCUPATIONS ACTUELLES (fils de pensée) :');
  if (prior.threads.length === 0) b.push('(aucune encore — esprit neuf)');
  for (const t of prior.threads) {
    b.push(
      `- [${t.id}] « ${t.title} » — penche: ${t.mode} → ${t.target} | saillance ${t.salience} | maturité ${t.maturity} | ${t.cycles} cycles | ${t.status}`,
    );
    if (t.thoughts.length) b.push(`    pensées: ${t.thoughts.slice(-4).join(' | ')}`);
  }
  b.push('', 'PRIORITÉS DE DARIUS :', s.priorities || '(non définies — déduis-les des projets actifs)', '');
  b.push("CE QUE JE PERÇOIS AUJOURD'HUI :");
  b.push(`Lacunes (${s.gaps.length}) :`);
  for (const g of s.gaps.slice(0, 8)) {
    const o = g as Record<string, unknown>;
    b.push(`- ${str(o.topic)} : ${str(o.reason)} → ${str(o.suggestion)}`);
  }
  b.push(`Thèmes (${s.themes.length}) :`);
  for (const t of s.themes.slice(0, 8)) {
    const o = t as Record<string, unknown>;
    b.push(`- ${str(o.name)} : ${str(o.summary)}`);
  }
  b.push(`Liens manquants (${s.links.length}) :`);
  for (const l of s.links.slice(0, 8)) {
    const o = l as Record<string, unknown>;
    b.push(`- ${base(str(o.a))} ⇄ ${base(str(o.b))} : ${str(o.liaison) || str(o.reason)}`);
  }
  b.push(`Incohérences (${s.coherence.length}) :`);
  for (const c of s.coherence.slice(0, 8)) {
    const o = c as Record<string, unknown>;
    b.push(`- ${str(o.type)} ${base(str(o.a))}/${base(str(o.b))} : ${str(o.explanation)}`);
  }
  return b.join('\n');
}

function renderMentalMd(date: string, state: MentalState, faded: Thread[]): string {
  const o: string[] = [];
  o.push('---', 'type: hub', 'tags: [auto, etat-mental, hub]', `updated: ${date}`, '---', '');
  o.push('# 🧠 État mental du cerveau', '');
  o.push(`> Ce qui occupe le cerveau, ${date}. Il garde ces fils d'un jour à l'autre et les développe. Propose-only.`, '');
  if (state.threads.length === 0) o.push('_Esprit au repos — aucun fil actif._');
  for (const t of state.threads) {
    o.push(`## ${t.title}  ·  ${badge(t.status)}`);
    o.push(`- **Penche vers** : ${t.mode === 'create' ? 'CRÉER' : 'AMÉLIORER'} → \`${t.target}\``);
    o.push(`- **Pourquoi** : ${t.why}`);
    o.push(`- **Saillance** ${bar(t.salience)} · **Maturité** ${bar(t.maturity)} · ${t.cycles} cycles · depuis ${t.bornOn || date}`);
    if (t.thoughts.length) {
      o.push('- **Train de pensée** :');
      for (const th of t.thoughts) o.push(`  - ${th}`);
    }
    o.push('');
  }
  if (faded.length) {
    o.push('## 🍂 Estompés', ...faded.map(f => `- ${f.title}`), '');
  }
  return o.join('\n');
}

function renderReflection(date: string, state: MentalState, cz: Crystallized[], faded: Thread[]): string {
  const o: string[] = [];
  o.push('---', 'type: reflection', 'tags: [auto, reflection]', 'source: auto', `date: ${date}`, '---', '');
  o.push(`# 🧠 Journal du cerveau — ${date}`, '');
  o.push("> Propose-only. Ce que le cerveau a ruminé et produit, de lui-même. Rien n'a touché tes notes curées.", '');

  o.push("## Ce que j'ai en tête");
  if (state.threads.length === 0) o.push("- _Rien d'actif._");
  for (const t of state.threads) {
    o.push(`- **${t.title}** (${t.mode === 'create' ? 'créer' : 'améliorer'} → ${t.target}) — maturité ${t.maturity}, ${t.cycles} cycles, ${t.status}`);
    if (t.thoughts.length) o.push(`  - dernière pensée : ${t.thoughts[t.thoughts.length - 1]}`);
  }
  o.push('');

  o.push("## ✨ Ce qui a cristallisé aujourd'hui");
  if (cz.length === 0) o.push("- _Rien n'était mûr. J'ai surtout ruminé (c'est aussi penser)._");
  for (const c of cz) {
    o.push(
      `### ${c.thread.mode === 'create' ? 'CRÉÉ' : 'AMÉLIORÉ'} : ${c.thread.target}`,
      `- Brouillon : [[${base(c.draftFile)}]]`,
      `- Sources : ${c.citations.map(x => `[[${base(x)}]]`).join(' · ') || '—'}`,
      `- Auto-critique : \`${c.verdict}\` (confiance ${c.confidence}) — ${c.critique || '—'}`,
      '',
    );
  }
  if (faded.length) o.push('## 🍂 Estompés', ...faded.map(f => `- ${f.title}`), '');
  return o.join('\n');
}

function renderInbox(date: string, state: MentalState, cz: Crystallized[], consolidation: string[]): string {
  const o: string[] = [];
  o.push('---', 'type: hub', 'tags: [auto, inbox, hub]', `updated: ${date}`, '---', '');
  o.push('# 📥 Inbox cerveau → Darius', '');
  o.push(`> ${date}. Ce qui m'occupe et ce que j'ai produit seul. Valide, rejette ou redirige (édite \`_priorities.md\`).`, '');

  o.push("## 🧠 Ce qui m'occupe");
  if (state.threads.length === 0) o.push("- _Rien pour l'instant._");
  for (const t of state.threads)
    o.push(
      `- **${t.title}** — ${t.mode === 'create' ? 'je veux créer' : 'je veux améliorer'} \`${t.target}\` ` +
        `_(maturité ${t.maturity}${t.status === 'ripe' ? ', mûr' : ''})_`,
    );
  o.push('');

  o.push("## ✨ Sorti aujourd'hui (à valider)");
  if (cz.length === 0) o.push("- _Rien n'a cristallisé — journée de rumination._");
  for (const c of cz)
    o.push(
      `- **${c.thread.mode === 'create' ? 'CRÉÉ' : 'AMÉLIORÉ'} : ${c.thread.target}** → [[${base(c.draftFile)}]] ` +
        `_(auto-critique : ${c.verdict}, ${c.confidence})_`,
    );
  o.push('');

  o.push('## 🧹 À consolider (captures → savoir)');
  if (consolidation.length === 0) o.push('- _Rien à consolider._');
  for (const p of consolidation) o.push(`- ${p}`);
  o.push('');

  const ask = cz.filter(c => c.verdict === 'needs_human');
  o.push('## ❓ Ton avis demandé');
  if (ask.length === 0) o.push('- _Aucune question bloquante._');
  for (const c of ask) o.push(`- **${c.thread.target}** — ${c.critique || c.thread.why}`);
  o.push('');
  return o.join('\n');
}

function wrapDraft(thread: Thread, body: string, date: string, citations: string[]): string {
  const head = [
    '---',
    'type: draft',
    'tags: [auto, draft, proposed]',
    'source: auto',
    'status: proposed-draft',
    `mode: ${thread.mode}`,
    `thread: ${thread.id}`,
    `date: ${date}`,
    '---',
    '',
    `> 🌱 Brouillon proposé par le cerveau (${thread.mode === 'create' ? 'création' : 'amélioration'} de **${thread.target}**). À valider avant promotion dans les notes curées.`,
    '',
  ].join('\n');
  const foot = citations.length
    ? `\n\n---\n*Matière : ${citations.map(c => `[[${base(c)}]]`).join(' · ')}*`
    : '';
  return `${head}${body.trim()}${foot}\n`;
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
    '| Date | Cible | Mode | Verdict | Confiance |',
    '|------|-------|------|---------|-----------|',
  ].join('\n');
}

/** Keep the header block + the last MAX_LOG_ROWS data rows (bounded growth). */
function rotateLog(text: string): string {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l => l.startsWith('| Date |'));
  if (headerIdx === -1) return `${text}\n`;
  const headerBlock = lines.slice(0, headerIdx + 2); // through the |---| separator
  const rows = lines.slice(headerIdx + 2).filter(l => l.startsWith('|'));
  return [...headerBlock, ...rows.slice(-MAX_LOG_ROWS)].join('\n') + '\n';
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
      const v = o.file ?? o.path ?? o.title ?? o.source;
      if (typeof v === 'string') out.push(v);
    }
    if (out.length >= 8) break;
  }
  return [...new Set(out)];
}

function normMode(value: unknown): Mode {
  const v = String(value ?? '').toLowerCase();
  if (v.startsWith('impro') || v.startsWith('amel') || v.startsWith('amél')) return 'improve';
  return 'create'; // safer default than improve (no missing-target read)
}

function normStatus(value: unknown): ThreadStatus {
  const v = String(value ?? '').toLowerCase();
  return (['active', 'ripe', 'crystallized', 'faded'] as const).includes(v as never)
    ? (v as ThreadStatus)
    : 'active';
}

function normVerdict(value: unknown): Crystallized['verdict'] {
  const v = String(value ?? '').toLowerCase();
  return (['solid', 'weak', 'rejected', 'needs_human'] as const).includes(v as never)
    ? (v as Crystallized['verdict'])
    : 'weak';
}

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

function isSafeReadTarget(target: string): boolean {
  if (!looksLikePath(target)) return false;
  if (target.includes('..')) return false;
  if (target.startsWith('/') || target.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(target)) return false; // windows drive letter
  return true;
}

function looksLikePath(target: string): boolean {
  return /\.md$/i.test(target) || target.includes('/');
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toks(s: string): Set<string> {
  return new Set(slug(s).split('-').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function base(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.md$/i, '');
}

function bar(v: number): string {
  const n = Math.round(clamp01(v) * 5);
  return `${'●'.repeat(n)}${'○'.repeat(5 - n)}`;
}

function badge(s: ThreadStatus): string {
  return s === 'ripe' ? '🌟 mûr' : s === 'crystallized' ? '✅ cristallisé' : s === 'faded' ? '🍂' : '💭 actif';
}

function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '/').slice(0, 80);
}

function trunc(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Robust object extraction: tolerate LLM preamble by trying each '{' start. */
function parseJsonObject<T>(text: string): T | null {
  if (!text) return null;
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace === -1) return null;
  for (let i = text.indexOf('{'); i !== -1 && i <= lastBrace; i = text.indexOf('{', i + 1)) {
    try {
      return JSON.parse(text.slice(i, lastBrace + 1)) as T;
    } catch {
      /* try the next opening brace */
    }
  }
  return null;
}
