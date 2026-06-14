import { dot } from '@/services/rag/cosine';
import { aggregateNotes, clusterNotes } from '@/services/synapses/cluster';
import { extractWikilinks } from '@/services/synapses/wikilinks';
import type {
  CoherenceIssue,
  LinkSuggestion,
  LlmCompleter,
  NoteVector,
  Theme,
} from '@/services/synapses/types';
import type { RagService } from '@/services/rag/rag-service';
import type { ToolResponse } from '@/mcp/handlers/types';

// --- tunables ---------------------------------------------------------------
const LINK_THRESHOLD = 0.42; // min cosine to consider two notes link-worthy
const LINK_CROSS_FOLDER_BOOST = 0.04; // prioritise "invisible" cross-project links
const LINK_MAX_CANDIDATES = 20; // cap sent to the LLM (bounds cost)
const DEFAULT_LINK_TOPK = 12;

const COHERENCE_THRESHOLD = 0.5; // min cosine for a decision/spec pair to be a candidate
const DUPLICATE_THRESHOLD = 0.9; // near-identical notes → merge candidates
const COHERENCE_MAX = 15;

const THEME_THRESHOLD = 0.5; // cosine edge for connected-components clustering
const THEME_MIN_SIZE = 3;
const THEME_MAX = 12;
const EMERGING_FRACTION = 0.4; // ≥ this share of a cluster in capture folders ⇒ "emerging"

const SAMPLE_CHARS = 360;

export interface SynapsesOptions {
  rag: RagService;
  llm: LlmCompleter;
}

interface LinkArgs {
  folder?: string;
  top_k?: number;
}
interface CoherenceArgs {
  folder?: string;
}
interface ThemeArgs {
  folder?: string;
  min_cluster_size?: number;
}

/**
 * Synapses — surfaces connections the vault leaves implicit, by comparing notes
 * to each other (not to a query) over the RAG embedding index. Propose-only: it
 * never mutates notes. Each capability is bounded to a single LLM call.
 */
export class SynapsesService {
  private readonly rag: RagService;
  private readonly llm: LlmCompleter;

  constructor(options: SynapsesOptions) {
    this.rag = options.rag;
    this.llm = options.llm;
  }

  // --- public tool methods (ToolResponse envelopes) -----------------------

  async suggestLinks(args: LinkArgs = {}): Promise<ToolResponse> {
    try {
      const suggestions = await this.computeLinks(args);
      return ok({ suggestions, total: suggestions.length });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  async auditCoherence(args: CoherenceArgs = {}): Promise<ToolResponse> {
    try {
      const issues = await this.computeCoherence(args);
      return ok({ issues, total: issues.length });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  async findThemes(args: ThemeArgs = {}): Promise<ToolResponse> {
    try {
      const themes = await this.computeThemes(args);
      return ok({ themes, total: themes.length });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  /** Runs all three analyses and renders the weekly digest markdown. */
  async digestMarkdown(): Promise<string> {
    const [links, issues, themes] = await Promise.all([
      this.computeLinks({ top_k: 8 }),
      this.computeCoherence({}),
      this.computeThemes({}),
    ]);
    return renderDigest(links, issues, themes);
  }

  async digest(): Promise<ToolResponse> {
    try {
      const markdown = await this.digestMarkdown();
      return ok({ markdown });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  // --- core analyses ------------------------------------------------------

  private async notes(folder?: string): Promise<NoteVector[]> {
    await this.rag.ensureReady();
    let notes = aggregateNotes(this.rag.embeddedChunks, isExcluded);
    if (folder) notes = notes.filter(n => n.file.startsWith(folder));
    return notes;
  }

  private async computeLinks(args: LinkArgs): Promise<LinkSuggestion[]> {
    const notes = await this.notes(args.folder);
    if (notes.length < 2) return [];

    const links = notes.map(n => ({ note: n, out: extractWikilinks(n.body) }));
    const topK = clamp(args.top_k, DEFAULT_LINK_TOPK, 1, 30);

    const candidates: Array<{ a: NoteVector; b: NoteVector; cos: number; adj: number }> = [];
    for (let i = 0; i < links.length; i++) {
      for (let j = i + 1; j < links.length; j++) {
        const a = links[i];
        const b = links[j];
        const cos = dot(a.note.embedding, b.note.embedding);
        if (cos < LINK_THRESHOLD) continue;
        if (a.out.has(b.note.wikilink.toLowerCase()) || b.out.has(a.note.wikilink.toLowerCase())) {
          continue; // already linked
        }
        const crossFolder = topFolder(a.note.file) !== topFolder(b.note.file);
        candidates.push({
          a: a.note,
          b: b.note,
          cos,
          adj: cos + (crossFolder ? LINK_CROSS_FOLDER_BOOST : 0),
        });
      }
    }
    if (candidates.length === 0) return [];

    candidates.sort((x, y) => y.adj - x.adj);
    const shortlist = candidates.slice(0, LINK_MAX_CANDIDATES);

    const prompt = shortlist
      .map(
        (c, i) =>
          `[${i + 1}] A = [[${c.a.wikilink}]] (${c.a.file})\n${trunc(c.a.sample)}\n` +
          `    B = [[${c.b.wikilink}]] (${c.b.file})\n${trunc(c.b.sample)}`,
      )
      .join('\n\n');

    const raw = await this.llm.complete(
      LINK_SYSTEM,
      `Paires de notes proches mais NON reliées :\n\n${prompt}`,
      1500,
    );
    const judged = parseJsonArray<{
      n: number;
      worthwhile: boolean;
      reason?: string;
      liaison?: string;
    }>(raw);

    const out: LinkSuggestion[] = [];
    for (const v of judged) {
      if (!v?.worthwhile) continue;
      const cand = shortlist[(v.n ?? 0) - 1];
      if (!cand) continue;
      out.push({
        a: cand.a.file,
        b: cand.b.file,
        score: round(cand.cos),
        reason: (v.reason ?? '').trim(),
        liaison: (v.liaison ?? '').trim(),
      });
    }
    return out.slice(0, topK);
  }

  private async computeCoherence(args: CoherenceArgs): Promise<CoherenceIssue[]> {
    const notes = await this.notes(args.folder);
    if (notes.length < 2) return [];

    type Cand = { a: NoteVector; b: NoteVector; cos: number; dup: boolean };
    const cands: Cand[] = [];
    const decisionLike = notes.filter(isDecisionLike);

    // Contradiction / staleness: decision & spec notes that overlap semantically.
    for (let i = 0; i < decisionLike.length; i++) {
      for (let j = i + 1; j < decisionLike.length; j++) {
        const cos = dot(decisionLike[i].embedding, decisionLike[j].embedding);
        if (cos >= COHERENCE_THRESHOLD) {
          cands.push({ a: decisionLike[i], b: decisionLike[j], cos, dup: false });
        }
      }
    }
    // Duplicates: near-identical notes anywhere in the vault.
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const cos = dot(notes[i].embedding, notes[j].embedding);
        if (cos >= DUPLICATE_THRESHOLD) cands.push({ a: notes[i], b: notes[j], cos, dup: true });
      }
    }
    if (cands.length === 0) return [];

    cands.sort((x, y) => y.cos - x.cos);
    const shortlist = cands.slice(0, COHERENCE_MAX);

    const prompt = shortlist
      .map(
        (c, i) =>
          `[${i + 1}]${c.dup ? ' (quasi-identiques)' : ''}\n` +
          `A = [[${c.a.wikilink}]] (${c.a.file})\n${trunc(c.a.sample)}\n` +
          `B = [[${c.b.wikilink}]] (${c.b.file})\n${trunc(c.b.sample)}`,
      )
      .join('\n\n');

    const raw = await this.llm.complete(
      COHERENCE_SYSTEM,
      `Paires de notes à auditer :\n\n${prompt}`,
      1500,
    );
    const judged = parseJsonArray<{
      n: number;
      type: 'contradiction' | 'stale' | 'duplicate' | 'none';
      explanation?: string;
    }>(raw);

    const out: CoherenceIssue[] = [];
    for (const v of judged) {
      if (!v || v.type === 'none' || !v.type) continue;
      const cand = shortlist[(v.n ?? 0) - 1];
      if (!cand) continue;
      out.push({
        type: v.type,
        a: cand.a.file,
        b: cand.b.file,
        score: round(cand.cos),
        explanation: (v.explanation ?? '').trim(),
      });
    }
    return out;
  }

  private async computeThemes(args: ThemeArgs): Promise<Theme[]> {
    const notes = await this.notes(args.folder);
    if (notes.length < THEME_MIN_SIZE) return [];

    const minSize = clamp(args.min_cluster_size, THEME_MIN_SIZE, 2, 20);
    const clusters = clusterNotes(notes, THEME_THRESHOLD)
      .filter(c => c.length >= minSize)
      .slice(0, THEME_MAX);
    if (clusters.length === 0) return [];

    const prompt = clusters
      .map(
        (c, i) =>
          `[${i + 1}] Notes : ${c.map(n => `[[${n.wikilink}]]`).join(', ')}\n` +
          `Extrait représentatif : ${trunc(c[0].sample)}`,
      )
      .join('\n\n');

    const raw = await this.llm.complete(
      THEME_SYSTEM,
      `Clusters de notes (regroupées par proximité sémantique) :\n\n${prompt}`,
      1800,
    );
    const named = parseJsonArray<{ n: number; name?: string; summary?: string }>(raw);
    const byN = new Map(named.map(v => [v.n, v]));

    return clusters.map((cluster, i) => {
      const meta = byN.get(i + 1);
      const captureCount = cluster.filter(n => isCaptureFolder(n.file)).length;
      return {
        name: (meta?.name ?? `Thème ${i + 1}`).trim(),
        summary: (meta?.summary ?? '').trim(),
        notes: cluster.map(n => n.file),
        emerging: captureCount / cluster.length >= EMERGING_FRACTION,
      };
    });
  }
}

// --- prompts ----------------------------------------------------------------

const LINK_SYSTEM = [
  'Tu analyses un « deuxième cerveau » : des notes Markdown reliées par des wikilinks [[ ]].',
  'On te donne des paires de notes sémantiquement proches mais qui ne sont PAS encore reliées.',
  'Pour chaque paire, décide si créer un lien [[ ]] entre elles serait RÉELLEMENT utile au propriétaire.',
  'Sois exigeant : refuse les rapprochements superficiels (juste « même domaine ») ; ne garde que les liens qui apportent une connexion concrète et actionnable.',
  'Quand worthwhile=true, donne une phrase de liaison courte expliquant le rapport précis entre les deux notes.',
  'Réponds UNIQUEMENT avec un tableau JSON, un objet par paire (utilise le numéro [n] donné) :',
  '[{"n":1,"worthwhile":true,"reason":"…","liaison":"…"}, {"n":2,"worthwhile":false}]',
].join('\n');

const COHERENCE_SYSTEM = [
  "Tu audites la cohérence d'un « deuxième cerveau » (notes Markdown, surtout des décisions et specs de projets).",
  'On te donne des paires de notes proches. Pour chacune, détermine son type :',
  '- "contradiction" : les deux notes affirment/décident des choses incompatibles.',
  '- "stale" : l\'une rend l\'autre périmée/obsolète (décision remplacée, info dépassée).',
  '- "duplicate" : les deux disent essentiellement la même chose (à fusionner).',
  '- "none" : aucun problème (proximité normale).',
  'Sois prudent : ne signale un problème que si tu en es raisonnablement sûr.',
  'Réponds UNIQUEMENT avec un tableau JSON, un objet par paire (numéro [n] donné) :',
  '[{"n":1,"type":"contradiction","explanation":"…"}, {"n":2,"type":"none"}]',
].join('\n');

const THEME_SYSTEM = [
  "On te donne des clusters de notes d'un « deuxième cerveau », regroupées par proximité sémantique.",
  "Pour chaque cluster, donne un nom de thème court et percutant, et un résumé d'une à deux phrases de ce qui relie ces notes.",
  'Réponds UNIQUEMENT avec un tableau JSON, un objet par cluster (numéro [n] donné) :',
  '[{"n":1,"name":"…","summary":"…"}]',
].join('\n');

// --- digest rendering -------------------------------------------------------

function renderDigest(links: LinkSuggestion[], issues: CoherenceIssue[], themes: Theme[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: hub');
  lines.push('tags: [synapses, hub]');
  lines.push(`updated: ${date}`);
  lines.push('---');
  lines.push('');
  lines.push('# 🧬 Synapses — bilan du cerveau');
  lines.push('');
  lines.push(
    `> Généré automatiquement le ${date}. Suggestions uniquement — rien n'a été modifié dans tes notes.`,
  );
  lines.push('');

  lines.push('## 🔗 Liens manquants suggérés');
  if (links.length === 0) lines.push('- _Rien de notable cette fois._');
  else
    for (const l of links)
      lines.push(
        `- [[${base(l.a)}]] ⇄ [[${base(l.b)}]] — ${l.liaison || l.reason} _(score ${l.score})_`,
      );
  lines.push('');

  lines.push('## ⚖️ Cohérence');
  if (issues.length === 0) lines.push('- _Aucune contradiction / doublon détecté._');
  else
    for (const it of issues)
      lines.push(
        `- **${labelIssue(it.type)}** — [[${base(it.a)}]] / [[${base(it.b)}]] : ${it.explanation}`,
      );
  lines.push('');

  lines.push('## 🌌 Thèmes émergents');
  if (themes.length === 0) lines.push('- _Pas de cluster significatif._');
  else
    for (const t of themes) {
      lines.push(`### ${t.name}${t.emerging ? ' 🌱 _(en émergence)_' : ''}`);
      if (t.summary) lines.push(t.summary);
      lines.push(t.notes.map(n => `[[${base(n)}]]`).join(' · '));
      lines.push('');
    }

  return lines.join('\n');
}

// --- helpers ----------------------------------------------------------------

function isExcluded(file: string): boolean {
  return file === '00-synapses.md' || file.startsWith('_templates/');
}

function topFolder(file: string): string {
  return file.split('/')[0];
}

function isDecisionLike(note: NoteVector): boolean {
  return (
    note.tags.includes('decision') ||
    note.tags.includes('spec') ||
    /\/(decisions|specs)\//.test(note.file)
  );
}

function isCaptureFolder(file: string): boolean {
  return file.startsWith('01-raw/') || file.startsWith('03-daily/');
}

function base(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.md$/i, '');
}

function labelIssue(type: CoherenceIssue['type']): string {
  return type === 'contradiction' ? 'Contradiction' : type === 'stale' ? 'Périmé' : 'Doublon';
}

function trunc(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SAMPLE_CHARS ? `${collapsed.slice(0, SAMPLE_CHARS)}…` : collapsed;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!value || value < min) return fallback;
  return Math.min(Math.floor(value), max);
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
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

function ok(data: Record<string, unknown>): ToolResponse {
  return { success: true, data, metadata: { timestamp: new Date().toISOString() } };
}

function fail(error: string): ToolResponse {
  return { success: false, error, metadata: { timestamp: new Date().toISOString() } };
}
