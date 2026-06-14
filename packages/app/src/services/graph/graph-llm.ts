import Anthropic from '@anthropic-ai/sdk';
import type { GraphExtraction, GraphLlm, Relation } from '@/services/graph/types';

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

/** GraphLlm via Claude: cheap/fast Haiku for per-note extraction, the generation model for synthesis. */
export class AnthropicGraphLlm implements GraphLlm {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly extractModel = 'claude-haiku-4-5',
    private readonly synthModel = 'claude-opus-4-8',
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(noteText: string): Promise<GraphExtraction> {
    const res = await this.client.messages.create({
      model: this.extractModel,
      max_tokens: 1024,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: noteText.slice(0, 6000) }],
    });
    if (res.stop_reason === 'refusal') return { entities: [], relations: [] };
    return parseExtraction(textOf(res));
  }

  async synthesize(question: string, context: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.synthModel,
      max_tokens: 1500,
      system: SYNTHESIZE_SYSTEM,
      messages: [{ role: 'user', content: `Graphe :\n${context}\n\nQuestion : ${question}` }],
    });
    if (res.stop_reason === 'refusal') return '';
    return textOf(res);
  }
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
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
