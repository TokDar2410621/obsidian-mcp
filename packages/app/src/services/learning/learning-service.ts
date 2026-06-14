import { toWikilink } from '@/services/rag/chunker';
import type { RagService } from '@/services/rag/rag-service';
import type { LlmCompleter } from '@/services/synapses/types';
import type { ToolResponse } from '@/mcp/handlers/types';

const CAPTURE_PREFIXES = ['01-raw/', '03-daily/'];
const MAX_CAPTURES = 40;
const MAX_INVENTORY = 200;
const SAMPLE_CHARS = 320;

export interface ConsolidationProposal {
  action: 'promote' | 'merge';
  title: string;
  summary: string;
  sources: string[];
}
export interface Gap {
  topic: string;
  reason: string;
  suggestion: string;
}

export interface LearningServiceOptions {
  rag: RagService;
  llm: LlmCompleter;
}

/**
 * The two analysis loops of the learning system (the feedback loop lives in
 * {@link LearningsStore}):
 * - consolidate(): "reflection" — distil raw/daily captures into proposed
 *   knowledge notes (promote) or merges.
 * - findGaps(): surface under-documented / stale areas.
 * Propose-only (never writes notes); each is one LLM call.
 */
export class LearningService {
  private readonly rag: RagService;
  private readonly llm: LlmCompleter;

  constructor(options: LearningServiceOptions) {
    this.rag = options.rag;
    this.llm = options.llm;
  }

  async consolidate(): Promise<ToolResponse> {
    try {
      const proposals = await this.computeConsolidation();
      return ok({ proposals, total: proposals.length });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  async findGaps(): Promise<ToolResponse> {
    try {
      const gaps = await this.computeGaps();
      return ok({ gaps, total: gaps.length });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  /** Weekly maintenance report (consolidation + gaps) for the cron to write. */
  async maintenanceMarkdown(): Promise<string> {
    const [proposals, gaps] = await Promise.all([this.computeConsolidation(), this.computeGaps()]);
    return renderMaintenance(proposals, gaps);
  }

  // --- analyses -----------------------------------------------------------

  private async computeConsolidation(): Promise<ConsolidationProposal[]> {
    await this.rag.ensureReady();
    const captures = this.captureNotes();
    if (captures.length === 0) return [];

    const prompt = captures
      .slice(0, MAX_CAPTURES)
      .map(c => `${c.file}\n${trunc(c.text)}`)
      .join('\n\n');
    const raw = await this.llm.complete(
      CONSOLIDATE_SYSTEM,
      `Captures brutes (raw / daily) :\n\n${prompt}`,
      2000,
    );
    return parseJsonArray<ConsolidationProposal>(raw)
      .filter(p => p && p.title && (p.action === 'promote' || p.action === 'merge'))
      .map(p => ({
        action: p.action,
        title: String(p.title).trim(),
        summary: String(p.summary ?? '').trim(),
        sources: Array.isArray(p.sources) ? p.sources.map(String) : [],
      }));
  }

  private async computeGaps(): Promise<Gap[]> {
    await this.rag.ensureReady();
    const inventory = this.inventory();
    if (inventory.length === 0) return [];
    const captures = this.captureNotes().slice(0, 25);

    const prompt =
      `Inventaire des notes :\n${inventory.join('\n')}\n\n` +
      `Captures récentes :\n${captures.map(c => `${c.file} — ${trunc(c.text)}`).join('\n')}`;
    const raw = await this.llm.complete(GAPS_SYSTEM, prompt, 1500);
    return parseJsonArray<Gap>(raw)
      .filter(g => g && g.topic)
      .map(g => ({
        topic: String(g.topic).trim(),
        reason: String(g.reason ?? '').trim(),
        suggestion: String(g.suggestion ?? '').trim(),
      }));
  }

  // --- vault views (from the RAG chunks, no extra git sync) ---------------

  private captureNotes(): Array<{ file: string; text: string }> {
    const byFile = new Map<string, string>();
    for (const c of this.rag.embeddedChunks) {
      if (CAPTURE_PREFIXES.some(p => c.file.startsWith(p))) {
        byFile.set(c.file, (byFile.get(c.file) ?? '') + c.text + '\n');
      }
    }
    return [...byFile.entries()].map(([file, text]) => ({ file, text }));
  }

  private inventory(): string[] {
    const titles = new Map<string, string>();
    for (const c of this.rag.embeddedChunks) {
      if (c.file.startsWith('_templates/') || c.file === '00-synapses.md') continue;
      if (!titles.has(c.file)) titles.set(c.file, c.title);
    }
    return [...titles.entries()]
      .slice(0, MAX_INVENTORY)
      .map(([file, title]) => `- ${file} (${title})`);
  }
}

// --- prompts ----------------------------------------------------------------

const CONSOLIDATE_SYSTEM = [
  'Tu consolides un « deuxième cerveau » : tu transformes des captures brutes (dossiers 01-raw / 03-daily) en SAVOIR structuré.',
  'Propose des notes de savoir à créer (action "promote") en regroupant des captures liées, et des fusions (action "merge") quand des captures se recouvrent.',
  "Sois sélectif : ne propose que ce qui mérite vraiment d'être consolidé. Donne un titre clair et un résumé d'1-2 phrases.",
  'Réponds UNIQUEMENT en JSON : [{"action":"promote","title":"…","summary":"…","sources":["01-raw/…"]}].',
].join('\n');

const GAPS_SYSTEM = [
  "Tu repères les LACUNES d'un « deuxième cerveau » à partir de l'inventaire des notes et des captures récentes.",
  "Identifie : (a) des sujets qui reviennent souvent mais n'ont pas de note dédiée, (b) des zones qui semblent périmées, (c) des trous évidents dans la connaissance.",
  'Sois concret et actionnable. Réponds UNIQUEMENT en JSON : [{"topic":"…","reason":"…","suggestion":"…"}].',
].join('\n');

// --- rendering --------------------------------------------------------------

function renderMaintenance(proposals: ConsolidationProposal[], gaps: Gap[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('---', 'type: hub', 'tags: [learning, hub]', `updated: ${date}`, '---', '');
  lines.push('# 🧹 Maintenance du cerveau', '');
  lines.push(`> Généré le ${date}. Suggestions uniquement — rien n'a été modifié.`, '');

  lines.push('## 📥 Consolidation (captures → savoir)');
  if (proposals.length === 0) lines.push('- _Rien à consolider._');
  else
    for (const p of proposals)
      lines.push(
        `- **${p.action === 'merge' ? 'Fusionner' : 'Promouvoir'} : ${p.title}** — ${p.summary} ` +
          `${p.sources.map(s => `[[${toWikilink(s)}]]`).join(' ')}`,
      );
  lines.push('');

  lines.push('## 🕳️ Lacunes');
  if (gaps.length === 0) lines.push('- _Aucune lacune évidente._');
  else for (const g of gaps) lines.push(`- **${g.topic}** — ${g.reason} → ${g.suggestion}`);
  lines.push('');

  return lines.join('\n');
}

// --- helpers ----------------------------------------------------------------

function trunc(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SAMPLE_CHARS ? `${collapsed.slice(0, SAMPLE_CHARS)}…` : collapsed;
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
