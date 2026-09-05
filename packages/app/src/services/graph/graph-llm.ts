import type { GraphExtraction, GraphLlm, Relation } from '@/services/graph/types';
import type { LlmCompleter } from '@/services/synapses/types';
import { logger } from '@/utils/logger';

/**
 * Drop unpaired UTF-16 surrogates.
 *
 * The chunker windows text at a fixed number of UTF-16 units (`chunker.ts`,
 * `windowText`), so a cut can land in the middle of a surrogate pair;
 * `noteTexts()` then rejoins the pieces with a newline and the pair never
 * reforms. `JSON.stringify` in the provider SDK turns that lone half into an
 * invalid request body, and the API answers `400 invalid high surrogate in
 * string`.
 *
 * Real case (2026-08-18 to 2026-09-01): LinkedIn pseudo-bold letters
 * (MATHEMATICAL SANS-SERIF BOLD, U+1D5xx) pasted into two raw transcripts froze
 * every graph build at note 128 of 1933 for two weeks, and every build threw
 * away the 127 extractions it had already paid for.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

const EXTRACT_SYSTEM = [
  'Tu extrais un graphe de connaissances depuis une note Markdown (projets, savoir, personnes).',
  'Repère les ENTITÉS importantes (projets, technologies, personnes, concepts, décisions) et les RELATIONS entre elles.',
  'Noms d\'entités courts et canoniques (ex: "Redis", "SendMeNow", "Stripe Connect"). Ignore le bla-bla.',
  'Réponds UNIQUEMENT en JSON : {"entities":["..."],"relations":[{"source":"A","relation":"utilise","target":"B"}]}.',
].join('\n');

const SYNTHESIZE_SYSTEM = [
  'Tu réponds à une question en raisonnant sur un GRAPHE DE CONNAISSANCES extrait des notes de Darius.',
  'On te donne des relations (triplets) et des notes connectées. Connecte les points — raisonnement multi-sauts.',
  "Cite les notes sources en wikilinks [[nom]]. Si le graphe ne contient pas l'info, dis-le clairement.",
].join('\n');

/**
 * Output budget for one extraction.
 *
 * Was 1024, and that number alone kept 695 notes out of the graph. A 6000-char
 * note yields an entities + relations object well past 1024 tokens, so the JSON
 * was cut before its closing brace, `JSON.parse` threw, and the bare `catch`
 * below reported "empty" for a perfectly good answer. Reasoning models made it
 * worse: an unclosed `<think>` block consumed the whole budget and `stripThink`
 * returned the empty string (`answerChars: 0` in the logs).
 *
 * Raising it costs nothing on well-behaved notes: models stop at their closing
 * brace. It only pays out where the old ceiling was truncating.
 */
const EXTRACT_MAX_TOKENS = 4096;

/** GraphLlm via the runtime-selected {@link LlmCompleter} (extraction + synthesis). */
export class LlmGraph implements GraphLlm {
  constructor(private readonly llm: LlmCompleter) {}

  async extract(noteText: string): Promise<GraphExtraction> {
    const input = stripLoneSurrogates(noteText.slice(0, 6000));
    const text = await this.llm.complete(EXTRACT_SYSTEM, input, EXTRACT_MAX_TOKENS);
    const extraction = parseExtraction(text);
    // An empty extraction used to be indistinguishable from "the note says
    // nothing": nothing was logged anywhere, so 688 blind notes out of 803 went
    // unnoticed for weeks. Leave a trace carrying enough of the raw answer to
    // tell a truncation from an unreadable format.
    if (extraction.entities.length === 0 && input.length >= 300) {
      logger.warn('Graph extraction came back empty', {
        chars: input.length,
        answerChars: text.length,
        answerHead: text.slice(0, 200),
      });
    }
    return extraction;
  }

  async synthesize(question: string, context: string): Promise<string> {
    return this.llm.complete(
      SYNTHESIZE_SYSTEM,
      `Graphe :\n${context}\n\nQuestion : ${question}`,
      1500,
    );
  }
}

export function parseExtraction(text: string): GraphExtraction {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return { entities: [], relations: [] };
  // An answer cut mid-array carries no closing brace at all. That is the most
  // common truncation, so it must reach the salvage rather than return empty.
  if (end === -1 || end < start) return sauverTronque(text.slice(start));
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const entities = Array.isArray(o.entities)
      ? o.entities.map((e: unknown) => String(e).trim()).filter(Boolean)
      : [];
    const relations: Relation[] = Array.isArray(o.relations)
      ? o.relations
          .filter((r: any) => r && r.source && r.target)
          .map((r: any) => ({
            source: String(r.source).trim(),
            relation: String(r.relation ?? 'lié à').trim(),
            target: String(r.target).trim(),
          }))
          .filter((r: Relation) => r.source && r.target)
      : [];
    return { entities, relations };
  } catch {
    // The JSON did not parse. Before giving up, salvage what is readable: a
    // truncated answer still carries every entity it had time to name, and
    // half a note in the graph beats none. This is what the old bare `catch`
    // threw away on every cut-off answer.
    return sauverTronque(text.slice(start));
  }
}

/**
 * Recover entities and relations from a JSON object that was cut off.
 *
 * Reads the two arrays element by element rather than as a whole, so a
 * truncation only loses what came after the cut.
 */
function sauverTronque(fragment: string): GraphExtraction {
  const entities: string[] = [];
  const relations: Relation[] = [];

  const blocEntites = /"entities"\s*:\s*\[([\s\S]*?)(?:\]|$)/.exec(fragment);
  if (blocEntites) {
    for (const m of blocEntites[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const nom = m[1].replace(/\\(.)/g, '$1').trim();
      if (nom) entities.push(nom);
    }
  }

  const blocRelations = /"relations"\s*:\s*\[([\s\S]*)$/.exec(fragment);
  if (blocRelations) {
    // Only complete triples: a half-written one would enter a wrong edge.
    for (const m of blocRelations[1].matchAll(/\{[^{}]*\}/g)) {
      try {
        const r = JSON.parse(m[0]);
        if (r?.source && r?.target) {
          relations.push({
            source: String(r.source).trim(),
            relation: String(r.relation ?? 'lié à').trim(),
            target: String(r.target).trim(),
          });
        }
      } catch {
        // skip this triple, keep the others
      }
    }
  }

  return { entities, relations: relations.filter(r => r.source && r.target) };
}
