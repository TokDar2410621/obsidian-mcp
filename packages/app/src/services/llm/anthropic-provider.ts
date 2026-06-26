import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '@/services/llm/types';

/** {@link ChatProvider} backed by the official Anthropic SDK (Claude). */
export class AnthropicProvider implements ChatProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(model: string, system: string, user: string, maxTokens: number): Promise<string> {
    const res = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') return '';
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
  }
}
