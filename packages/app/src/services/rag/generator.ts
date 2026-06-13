import Anthropic from '@anthropic-ai/sdk';
import type { AnswerGenerator, GenContext, GenResult } from '@/services/rag/types';

const SYSTEM_PROMPT = [
  "Tu es l'assistant du « deuxième cerveau » de Darius : un coffre de notes Markdown (projets, savoir, daily, personnes).",
  'On te fournit des extraits de notes récupérés par recherche sémantique. Réponds UNIQUEMENT à partir de ces extraits.',
  'Règles :',
  '- Réponds dans la langue de la question (français par défaut).',
  '- Cite tes sources en ligne avec des wikilinks Obsidian : `[[nom-de-la-note]]` (le nom est donné pour chaque extrait).',
  "- Si les extraits ne contiennent pas l'information, dis-le clairement (« Je ne trouve pas ça dans tes notes ») plutôt que d'inventer.",
  '- Sois concis et factuel. Ne paraphrase pas tout le contexte ; synthétise et pointe vers les notes.',
].join('\n');

/** Generates grounded answers with Claude via the official Anthropic SDK. */
export class AnthropicAnswerGenerator implements AnswerGenerator {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    public readonly model = 'claude-opus-4-8',
    private readonly maxTokens = 2048,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async generate(question: string, contexts: GenContext[]): Promise<GenResult> {
    const contextBlock = contexts
      .map((c, i) => {
        const label = c.heading ? `${c.wikilink} › ${c.heading}` : c.wikilink;
        return `[${i + 1}] [[${c.wikilink}]] (${label})\n${c.text}`;
      })
      .join('\n\n---\n\n');

    const userMessage = `Extraits de notes :\n\n${contextBlock}\n\n---\n\nQuestion : ${question}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    if (response.stop_reason === 'refusal') {
      return { answer: '', refused: true };
    }

    const answer = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    return { answer, refused: false };
  }
}
