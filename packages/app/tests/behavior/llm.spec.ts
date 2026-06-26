import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { OpenAiProvider, AnthropicProvider, createChatProvider } from '@/services/llm';

beforeAll(() => {
  configureLogger({ stream: { write: () => true } as unknown as NodeJS.WriteStream });
});

describe('OpenAiProvider (OpenAI-compatible chat)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to {baseURL}/chat/completions with system+user and returns trimmed content', async () => {
    let captured: any;
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '  hi  ' } }] }) };
    });

    const p = new OpenAiProvider('https://router.huggingface.co/v1/', 'hf_x');
    const out = await p.chat('meta-llama/Llama-3.3-70B-Instruct', 'sys', 'user', 256);

    expect(out).toBe('hi');
    expect(captured.url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(captured.auth).toBe('Bearer hf_x');
    expect(captured.body.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(captured.body.max_tokens).toBe(256);
    expect(captured.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
  });

  it('throws with the status on a non-ok response', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    const p = new OpenAiProvider('https://x/v1', 'k');
    await expect(p.chat('m', 's', 'u', 10)).rejects.toThrow(/429/);
  });

  it('returns "" when the response carries no content', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    const p = new OpenAiProvider('https://x/v1', 'k');
    expect(await p.chat('m', 's', 'u', 10)).toBe('');
  });

  it('strips a leading <think> reasoning block (HF reasoning models)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '<think>réfléchissons [1,2]</think>La réponse finale.' } }],
      }),
    }));
    const p = new OpenAiProvider('https://x/v1', 'k');
    expect(await p.chat('m', 's', 'u', 10)).toBe('La réponse finale.');
  });

  it('joins array-form content (parts) into a string', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] } }],
      }),
    }));
    const p = new OpenAiProvider('https://x/v1', 'k');
    expect(await p.chat('m', 's', 'u', 10)).toBe('hello world');
  });

  it('throws on a non-JSON body instead of a raw SyntaxError', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    const p = new OpenAiProvider('https://x/v1', 'k');
    await expect(p.chat('m', 's', 'u', 10)).rejects.toThrow(/non-JSON/i);
  });

  it('throws on a 200 response carrying an { error } envelope', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ error: { message: 'model overloaded' } }),
    }));
    const p = new OpenAiProvider('https://x/v1', 'k');
    await expect(p.chat('m', 's', 'u', 10)).rejects.toThrow(/error/i);
  });
});

describe('createChatProvider env selection', () => {
  const KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'ANTHROPIC_API_KEY'];
  const clear = () => KEYS.forEach(k => delete process.env[k]);
  afterEach(clear);

  it('prefers OpenAI-compatible when LLM_BASE_URL + LLM_API_KEY are set', () => {
    clear();
    process.env.LLM_BASE_URL = 'https://router.huggingface.co/v1';
    process.env.LLM_API_KEY = 'hf_x';
    expect(createChatProvider()).toBeInstanceOf(OpenAiProvider);
  });

  it('falls back to Anthropic when only ANTHROPIC_API_KEY is set', () => {
    clear();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    expect(createChatProvider()).toBeInstanceOf(AnthropicProvider);
  });

  it('returns null when nothing is configured', () => {
    clear();
    expect(createChatProvider()).toBeNull();
  });
});
