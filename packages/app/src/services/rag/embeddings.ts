import type { EmbeddingProvider } from '@/services/rag/types';

const BATCH_SIZE = 64;
const MAX_INPUT_CHARS = 8000; // stay well under the 8191-token per-input limit

/**
 * OpenAI embeddings via the global `fetch` (Node 22). No SDK dependency — keeps
 * the footprint minimal and avoids pulling transitive deps into the build.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    public readonly model = 'text-embedding-3-small',
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const input = texts.slice(i, i + BATCH_SIZE).map(t => t.slice(0, MAX_INPUT_CHARS));
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenAI embeddings request failed (${res.status}): ${body.slice(0, 300)}`);
      }

      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      for (const item of json.data) out.push(item.embedding);
    }

    return out;
  }
}
