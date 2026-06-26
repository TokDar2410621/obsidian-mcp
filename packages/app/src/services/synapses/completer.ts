import type { LlmCompleter } from '@/services/synapses/types';
import type { ChatProvider } from '@/services/llm';

/**
 * Free-form completion via the configured {@link ChatProvider}. Used by Synapses
 * and the learning loops (task-specific prompts: judging link pairs, naming
 * clusters, distilling captures) rather than grounded Q&A.
 */
export class ProviderCompleter implements LlmCompleter {
  constructor(
    private readonly provider: ChatProvider,
    public readonly model = 'claude-opus-4-8',
    private readonly defaultMaxTokens = 2048,
  ) {}

  async complete(system: string, user: string, maxTokens = this.defaultMaxTokens): Promise<string> {
    return this.provider.chat(this.model, system, user, maxTokens);
  }
}
