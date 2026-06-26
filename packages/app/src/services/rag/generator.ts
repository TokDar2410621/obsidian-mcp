import type { AnswerGenerator, GenContext, GenResult } from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';

const SYSTEM_PROMPT = [
  "Tu es l'assistant du « deuxième cerveau » de Darius : un coffre de notes Markdown (projets, savoir, daily, personnes).",
  'On te fournit des extraits de notes récupérés par recherche sémantique. Réponds UNIQUEMENT à partir de ces extraits.',
  'Règles :',
  '- Réponds dans la langue de la question (français par défaut).',
  '- Cite tes sources en ligne avec des wikilinks Obsidian : `[[nom-de-la-note]]` (le nom est donné pour chaque extrait).',
  "- Si les extraits ne contiennent pas l'information, dis-le clairement (« Je ne trouve pas ça dans tes notes ») plutôt que d'inventer.",
  '- Sois concis et factuel. Ne paraphrase pas tout le contexte ; synthétise et pointe vers les notes.',
].join('\n');

/** Generates grounded answers via the runtime-selected LLM ({@link LlmCompleter}). */
export class RagAnswerGenerator implements AnswerGenerator {
  /** Vestigial label — the actual model is chosen per-call by the completer. */
  readonly model = 'dynamic';

  constructor(
    private readonly llm: LlmCompleter,
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

    const answer = await this.llm.complete(SYSTEM_PROMPT, userMessage, this.maxTokens);
    return { answer, refused: answer === '' };
  }
}
