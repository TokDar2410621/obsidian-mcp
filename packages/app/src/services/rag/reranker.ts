import Anthropic from '@anthropic-ai/sdk';

export interface RerankCandidate {
  id: string;
  text: string;
}

/** Reorders retrieval candidates by true relevance to the query. Injected for testability. */
export interface Reranker {
  /** Returns the candidate ids reordered best-first (completeness preserved). */
  rerank(query: string, candidates: RerankCandidate[]): Promise<string[]>;
}

const SYSTEM = [
  'Tu reclasses des extraits de notes par pertinence pour une requête (comme un reranker).',
  'Réponds UNIQUEMENT avec un tableau JSON des identifiants, du plus pertinent au moins pertinent.',
  'Inclus tous les identifiants donnés, n\'en invente aucun. Exemple : ["3","1","2"].',
].join('\n');

/**
 * LLM reranker via Claude (default Haiku — reranking is a light task, so a cheap
 * fast model keeps added latency/cost low). Reuses ANTHROPIC_API_KEY; no extra
 * provider or key. Any failure falls back to the input order, so rerank is safe.
 */
export class AnthropicReranker implements Reranker {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    public readonly model = 'claude-haiku-4-5',
    private readonly maxTokens = 512,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<string[]> {
    const fallback = candidates.map(c => c.id);
    const list = candidates
      .map(c => `[${c.id}] ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Requête : ${query}\n\nExtraits :\n${list}` }],
    });
    if (response.stop_reason === 'refusal') return fallback;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return fallback;

    try {
      const ids = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(ids)) return fallback;
      const valid = new Set(fallback);
      const ordered = ids.map(String).filter(id => valid.has(id));
      for (const id of fallback) if (!ordered.includes(id)) ordered.push(id); // keep completeness
      return ordered.length > 0 ? ordered : fallback;
    } catch {
      return fallback;
    }
  }
}
