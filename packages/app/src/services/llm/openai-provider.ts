import type { ChatProvider } from '@/services/llm/types';

/**
 * {@link ChatProvider} for any OpenAI-compatible Chat Completions endpoint:
 * Hugging Face's Inference Providers router (https://router.huggingface.co/v1),
 * OpenRouter, Groq, Together, Mistral, a self-hosted vLLM/Ollama, etc. Uses the
 * global `fetch` — no SDK dependency, so it never weighs on the bundle.
 */
export class OpenAiProvider implements ChatProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.endpoint = `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
    this.timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 60000;
    this.maxRetries = Number(process.env.LLM_MAX_RETRIES) || 3;
  }

  async chat(model: string, system: string, user: string, maxTokens: number): Promise<string> {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    // Retry transient failures (429 queue/rate limits — common on the HF router
    // under load — plus 5xx and network/timeout). Critical for the graph build,
    // which fires hundreds of calls back-to-back and saves all-or-nothing.
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          // Bound each attempt so a stalled/cold provider can't wedge ask-cerveau,
          // the graph build, or the digest cron forever.
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err: any) {
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`LLM provider request failed: ${err?.message ?? String(err)}`);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt, res.headers?.get?.('retry-after')));
          continue;
        }
        throw new Error(`LLM provider HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      // Some gateways return 200 with a non-JSON body (HTML error page, streamed
      // chunk) or a top-level { error } envelope — surface those as real errors.
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
      } | null;
      if (data == null) throw new Error('LLM provider returned a non-JSON body');
      if (data.error) throw new Error(`LLM provider error: ${JSON.stringify(data.error).slice(0, 300)}`);

      return cleanContent(data.choices?.[0]?.message?.content);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter; honors a `Retry-After` header (seconds) when present. */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 15000);
  }
  const base = Number(process.env.LLM_RETRY_BASE_MS ?? 500);
  return Math.min(base * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/** Coerce `message.content` to text — tolerates the array-of-parts shape some routers return. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'string' ? p : typeof (p as any)?.text === 'string' ? (p as any).text : ''))
      .join('');
  }
  return '';
}

/**
 * Strip a reasoning trace. The HF router serves reasoning models (DeepSeek-R1,
 * Qwen/QwQ, gpt-oss) whose `content` prefixes the answer with `<think>…</think>`;
 * left in, it pollutes ask-cerveau answers and corrupts the reranker/graph JSON scans.
 */
function stripThink(text: string): string {
  const close = text.lastIndexOf('</think>');
  if (close !== -1) return text.slice(close + '</think>'.length);
  if (/^\s*<think>/i.test(text)) return ''; // unclosed reasoning, no answer reached
  return text;
}

function cleanContent(content: unknown): string {
  return stripThink(extractText(content)).trim();
}
