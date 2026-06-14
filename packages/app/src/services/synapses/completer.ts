import Anthropic from '@anthropic-ai/sdk';
import type { LlmCompleter } from '@/services/synapses/types';

/**
 * Free-form completion via Claude (official Anthropic SDK). Separate from the
 * RAG {@link AnswerGenerator} because Synapses needs task-specific prompts
 * (judging link pairs, contradictions, naming clusters) rather than grounded Q&A.
 */
export class AnthropicCompleter implements LlmCompleter {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    public readonly model = 'claude-opus-4-8',
    private readonly defaultMaxTokens = 2048,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(system: string, user: string, maxTokens = this.defaultMaxTokens): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });

    if (response.stop_reason === 'refusal') return '';

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();
  }
}
