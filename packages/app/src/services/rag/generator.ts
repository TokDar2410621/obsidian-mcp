import type { AnswerGenerator, GenContext, GenResult } from '@/services/rag/types';
import type { ChatProvider } from '@/services/llm';

const SYSTEM_PROMPT = [
  "Tu es l'assistant du « deuxième cerveau » de Darius : un coffre de notes Markdown (projets, savoir, daily, personnes).",
  'On te fournit des extraits de notes récupérés par recherche sémantique. Réponds UNIQUEMENT à partir de ces extraits.',
  'Règles :',
  '- Réponds dans la langue de la question (français par défaut).',
  '- Cite tes sources en ligne avec des wikilinks Obsidian : `[[nom-de-la-note]]` (le nom est donné pour chaque extrait).',
  "- Si les extraits ne contiennent pas l'information, dis-le clairement (« Je ne trouve pas ça dans tes notes ») plutôt que d'inventer.",
  '- Sois concis et factuel. Ne paraphrase pas tout le contexte ; synthétise et pointe vers les notes.',
].join('\n');

/** Generates grounded answers via the configured {@link ChatProvider}. */
export class RagAnswerGenerator implements AnswerGenerator {
  constructor(
    private readonly provider: ChatProvider,
    public readonly model = 'claude-opus-4-8',
    private readonly maxTokens = 2048,
  ) {}

  async generate(question: string, contexts: GenContext[]): Promise<GenResult> {
    const contextBlock = contexts
      .map((c, i) => {
        const label = c.heading ? `${c.wikilink} › ${c.heading}` : c.wikilink;
        return `[${i + 1}] [[${c.wikilink}]] (${label})\n${c.text}`;
      })
      .join('\n\n---\n\n');

    const userMessage = `Extraits de notes :\n\n${contextBlock}\n\n---\n\nQuestion : ${question}`;

    const answer = await this.provider.chat(this.model, SYSTEM_PROMPT, userMessage, this.maxTokens);
    return { answer, refused: answer === '' };
  }
}
