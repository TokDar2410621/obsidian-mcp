import type { GraphExtraction, GraphLlm, Relation } from '@/services/graph/types';
import type { ChatProvider } from '@/services/llm';

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

/** GraphLlm via the configured provider: a fast model for per-note extraction, the generation model for synthesis. */
export class LlmGraph implements GraphLlm {
  constructor(
    private readonly provider: ChatProvider,
    private readonly extractModel = 'claude-haiku-4-5',
    private readonly synthModel = 'claude-opus-4-8',
  ) {}

  async extract(noteText: string): Promise<GraphExtraction> {
    const text = await this.provider.chat(
      this.extractModel,
      EXTRACT_SYSTEM,
      noteText.slice(0, 6000),
      1024,
    );
    return parseExtraction(text);
  }

  async synthesize(question: string, context: string): Promise<string> {
    return this.provider.chat(
      this.synthModel,
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
