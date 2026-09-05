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

/** GraphLlm via the runtime-selected {@link LlmCompleter} (extraction + synthesis). */
export class LlmGraph implements GraphLlm {
  constructor(private readonly llm: LlmCompleter) {}

  async extract(noteText: string): Promise<GraphExtraction> {
    const input = stripLoneSurrogates(noteText.slice(0, 6000));
    const text = await this.llm.complete(EXTRACT_SYSTEM, input, 1024);
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
  if (start === -1 || end === -1 || end < start) return { entities: [], relations: [] };
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
    return { entities: [], relations: [] };
  }
}
