import os from 'os';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { SettingsStore } from '@/services/settings/settings-store';
import type { CerveauSettings } from '@/services/settings/settings-store';
import { SettingsBackedCompleter } from '@/services/llm/settings-completer';

beforeAll(() => {
  configureLogger({ stream: { write: () => true } as unknown as NodeJS.WriteStream });
});

describe('SettingsStore', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(os.tmpdir(), `cerveau-settings-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  });
  afterEach(() => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  });

  it('returns env-derived defaults when no file exists', () => {
    const s = new SettingsStore(file).get();
    expect(['hf', 'openai', 'anthropic']).toContain(s.llm.provider);
    expect(typeof s.llm.model).toBe('string');
    expect(s.retrieval.topK).toBeGreaterThan(0);
  });

  it('persists an update and a fresh instance reloads it', () => {
    new SettingsStore(file).update({
      llm: { provider: 'anthropic', model: 'claude-x' },
      retrieval: { topK: 12, rerank: false },
    });
    const reloaded = new SettingsStore(file).get();
    expect(reloaded.llm.provider).toBe('anthropic');
    expect(reloaded.llm.model).toBe('claude-x');
    expect(reloaded.retrieval.topK).toBe(12);
    expect(reloaded.retrieval.rerank).toBe(false);
  });

  it('ignores malformed fields and clamps topK', () => {
    const store = new SettingsStore(file);
    const base = store.get();
    const { settings: out } = store.update({
      llm: { provider: 'bogus', model: 123 },
      retrieval: { topK: 999, rerank: 'yes' },
      filters: { folder: '  05-projects  ', tags: ['a', 2, ''] },
    });
    expect(out.llm.provider).toBe(base.llm.provider); // bogus → kept base
    expect(out.llm.model).toBe(base.llm.model); // non-string → kept base
    expect(out.retrieval.topK).toBe(30); // clamped
    expect(out.retrieval.rerank).toBe(base.retrieval.rerank); // non-boolean → base
    expect(out.filters.folder).toBe('05-projects'); // trimmed
    expect(out.filters.tags).toEqual(['a', '2']); // stringified, empties dropped
  });

  it('caps long strings and tag arrays', () => {
    const { settings } = new SettingsStore(file).update({
      llm: { provider: 'hf', model: 'x'.repeat(500) },
      filters: { folder: 'y'.repeat(500), tags: Array.from({ length: 100 }, (_, i) => `t${i}`) },
    });
    expect(settings.llm.model.length).toBe(200);
    expect(settings.filters.folder.length).toBe(200);
    expect(settings.filters.tags.length).toBe(50);
  });

  it('is not vulnerable to prototype pollution via a patch', () => {
    new SettingsStore(file).update(
      JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('defaults the model per provider (no hf slug for anthropic)', () => {
    const ENV = ['LLM_MODEL', 'RAG_GENERATION_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
    const snapshot = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    try {
      ENV.forEach(k => delete process.env[k]);
      process.env.ANTHROPIC_API_KEY = 'sk-ant';
      const s = new SettingsStore(file).get();
      expect(s.llm.provider).toBe('anthropic');
      expect(s.llm.model).toBe('claude-opus-4-8');
    } finally {
      ENV.forEach(k => {
        if (snapshot[k] === undefined) delete process.env[k];
        else process.env[k] = snapshot[k] as string;
      });
    }
  });
});

function fakeStore(llm: CerveauSettings['llm']): SettingsStore {
  return {
    get: () => ({ llm, retrieval: { topK: 8, rerank: true, hybrid: true }, filters: { folder: '', tags: [] } }),
  } as unknown as SettingsStore;
}

describe('SettingsBackedCompleter', () => {
  const KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  afterEach(() => {
    vi.unstubAllGlobals();
    KEYS.forEach(k => delete process.env[k]);
  });

  it('routes to the OpenAI-compatible (hf) endpoint chosen in settings', async () => {
    process.env.LLM_BASE_URL = 'https://router.huggingface.co/v1';
    process.env.LLM_API_KEY = 'hf_x';
    let url = '';
    vi.stubGlobal('fetch', async (u: string) => {
      url = u;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
    });
    const c = new SettingsBackedCompleter(fakeStore({ provider: 'hf', model: 'openai/gpt-oss-120b' }));
    expect(await c.complete('s', 'u', 10)).toBe('hi');
    expect(url).toContain('router.huggingface.co');
  });

  it('routes to api.openai.com when provider is openai', async () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    let url = '';
    vi.stubGlobal('fetch', async (u: string) => {
      url = u;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    });
    const c = new SettingsBackedCompleter(fakeStore({ provider: 'openai', model: 'gpt-4o-mini' }));
    expect(await c.complete('s', 'u', 10)).toBe('ok');
    expect(url).toContain('api.openai.com');
  });

  it('throws when the selected provider is not configured', async () => {
    const c = new SettingsBackedCompleter(fakeStore({ provider: 'anthropic', model: 'claude-x' }));
    await expect(c.complete('s', 'u', 10)).rejects.toThrow(/not configured/i);
  });
});
