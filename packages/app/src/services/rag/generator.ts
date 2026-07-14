import type { AnswerGenerator, GenContext, GenResult } from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';

/** Exact refusal sentence: the post-generation grounding check recognises it. */
export const REFUS_HORS_CERVEAU = 'Je ne trouve pas ça dans le cerveau.';

const SYSTEM_PROMPT = [
  "Tu es la voix du « deuxième cerveau » de Darius : un coffre de notes Markdown (projets, savoir, daily, personnes).",
  "On te fournit des extraits de notes récupérés par recherche sémantique. Ta SEULE source de vérité est ces extraits : tu n'as AUCUNE connaissance extérieure. Tout ce qui ne vient pas des extraits n'existe pas.",
  'Règles absolues :',
  "- Chaque affirmation de ta réponse doit être traçable à un extrait fourni, cité en ligne avec un wikilink Obsidian : `[[nom-de-la-note]]` (le nom est donné pour chaque extrait). Une réponse sans citation est invalide.",
  `- Si les extraits ne contiennent pas l'information demandée, réponds EXACTEMENT : « ${REFUS_HORS_CERVEAU} » et rien d'autre. Ne complète jamais avec du savoir général, même évident.`,
  "- Si les extraits ne couvrent qu'une partie de la question, réponds uniquement cette partie (citée) et termine par : « Le reste n'est pas dans le cerveau. »",
  '- Réponds dans la langue de la question (français par défaut).',
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
