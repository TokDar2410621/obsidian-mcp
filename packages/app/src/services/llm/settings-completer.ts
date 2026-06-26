import type { LlmCompleter } from '@/services/synapses/types';
import type { ChatProvider } from '@/services/llm/types';
import { AnthropicProvider } from '@/services/llm/anthropic-provider';
import { OpenAiProvider } from '@/services/llm/openai-provider';
import type { LlmProviderId, SettingsStore } from '@/services/settings/settings-store';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * The single LLM primitive behind every cerveau "thinking" task (generation,
 * rerank, synapses, graph, learning). Resolves the provider + model from the
 * {@link SettingsStore} on EACH call, so switching model/provider from the web
 * Settings page takes effect immediately — no redeploy.
 *
 * API keys never leave the server env: the provider id only selects which
 * configured backend to use (`hf` → LLM_BASE_URL/LLM_API_KEY, `openai` →
 * OPENAI_API_KEY, `anthropic` → ANTHROPIC_API_KEY).
 */
export class SettingsBackedCompleter implements LlmCompleter {
  private readonly providers = new Map<LlmProviderId, ChatProvider>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly defaultMaxTokens = 2048,
  ) {}

  /** The currently selected model (live from the settings store). */
  get model(): string {
    return this.settings.get().llm.model;
  }

  async complete(system: string, user: string, maxTokens = this.defaultMaxTokens): Promise<string> {
    const { provider: id, model } = this.settings.get().llm;
    const provider = this.providerFor(id);
    if (!provider) {
      throw new Error(
        `LLM provider '${id}' is selected but not configured on the server (missing API key/base URL).`,
      );
    }
    return provider.chat(model, system, user, maxTokens);
  }

  private providerFor(id: LlmProviderId): ChatProvider | null {
    const cached = this.providers.get(id);
    if (cached) return cached;
    const built = build(id);
    if (built) this.providers.set(id, built);
    return built;
  }
}

function build(id: LlmProviderId): ChatProvider | null {
  if (id === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    return key ? new AnthropicProvider(key) : null;
  }
  if (id === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    return key ? new OpenAiProvider(OPENAI_BASE_URL, key) : null;
  }
  // 'hf' (or any OpenAI-compatible endpoint behind LLM_BASE_URL).
  const baseUrl = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  return baseUrl && key ? new OpenAiProvider(baseUrl, key) : null;
}

/** True when at least one chat backend is configured (the boot gate). */
export function hasChatProvider(): boolean {
  return Boolean(
    (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY,
  );
}
