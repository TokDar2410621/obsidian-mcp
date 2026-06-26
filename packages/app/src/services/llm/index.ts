import { AnthropicProvider } from '@/services/llm/anthropic-provider';
import { OpenAiProvider } from '@/services/llm/openai-provider';
import type { ChatProvider } from '@/services/llm/types';
import { logger } from '@/utils/logger';

export type { ChatProvider } from '@/services/llm/types';
export { AnthropicProvider } from '@/services/llm/anthropic-provider';
export { OpenAiProvider } from '@/services/llm/openai-provider';

/**
 * Build the chat LLM behind the cerveau's thinking, or null when none is
 * configured (the LLM-backed tools then stay unregistered — search-cerveau,
 * which is embeddings-only, keeps working).
 *
 * Preference:
 *   1. `LLM_BASE_URL` + `LLM_API_KEY` → any OpenAI-compatible endpoint, e.g.
 *      Hugging Face (`https://router.huggingface.co/v1`), OpenRouter, Groq…
 *      Set the model env vars (or `LLM_MODEL`) to that provider's model ids.
 *   2. `ANTHROPIC_API_KEY` → Claude via the Anthropic SDK.
 */
export function createChatProvider(): ChatProvider | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const llmKey = process.env.LLM_API_KEY?.trim();
  if (baseUrl && llmKey) {
    if (!process.env.LLM_MODEL && !process.env.RAG_GENERATION_MODEL) {
      logger.warn(
        'LLM_BASE_URL is set but no model is configured — set LLM_MODEL. The claude-* defaults will 404 on a non-Anthropic provider.',
      );
    }
    logger.info('Using OpenAI-compatible LLM provider', { baseUrl });
    return new OpenAiProvider(baseUrl, llmKey);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) return new AnthropicProvider(anthropicKey);

  return null;
}

/** Default model name shared across consumers when a specific one isn't set. */
export function defaultLlmModel(fallback: string): string {
  return process.env.LLM_MODEL || fallback;
}
