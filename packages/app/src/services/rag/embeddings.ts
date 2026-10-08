import type { EmbeddingProvider } from '@/services/rag/types';

const BATCH_SIZE = 64;
const MAX_INPUT_CHARS = 8000; // stay well under the 8191-token per-input limit

/** Retries on 429 / 5xx: a full vault index easily exceeds the per-minute token limit. */
const MAX_ATTEMPTS = 8;
const MAX_WAIT_MS = 60_000;

export interface EmbeddingProviderOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long OpenAI asks us to wait: `Retry-After` (seconds), else the
 * "Please try again in 1.234s" / "in 250ms" hint of the error body, else an
 * exponential backoff. Measured on 2026-10-08: the first index of the guest
 * instance (Dan) hit the org's 1M tokens-per-minute limit within a minute,
 * and a single 429 used to abort the whole index build.
 */
export function waitBeforeRetry(attempt: number, retryAfter: string | null, body: string): number {
  const header = Number(retryAfter);
  if (retryAfter && Number.isFinite(header) && header >= 0) return Math.min(header * 1000 + 250, MAX_WAIT_MS);
  const hint = body.match(/try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (hint) {
    const ms = hint[2].toLowerCase() === 'ms' ? Number(hint[1]) : Number(hint[1]) * 1000;
    return Math.min(Math.ceil(ms) + 250, MAX_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

/**
 * OpenAI embeddings via the global `fetch` (Node 22). No SDK dependency — keeps
 * the footprint minimal and avoids pulling transitive deps into the build.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly apiKey: string,
    public readonly model = 'text-embedding-3-small',
    options: EmbeddingProviderOptions | string = {},
  ) {
    // Backward compatible: the third argument used to be the base URL.
    const opts = typeof options === 'string' ? { baseUrl: options } : options;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const input = texts.slice(i, i + BATCH_SIZE).map(t => t.slice(0, MAX_INPUT_CHARS));
      const json = await this.requestWithRetry(input);
      for (const item of json.data) out.push(item.embedding);
    }

    return out;
  }

  private async requestWithRetry(input: string[]): Promise<{ data: Array<{ embedding: number[] }> }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
      });

      if (res.ok) return (await res.json()) as { data: Array<{ embedding: number[] }> };

      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt + 1 >= MAX_ATTEMPTS) {
        throw new Error(`OpenAI embeddings request failed (${res.status}): ${body.slice(0, 300)}`);
      }
      await this.sleep(waitBeforeRetry(attempt, res.headers.get('retry-after'), body));
    }
  }
}
