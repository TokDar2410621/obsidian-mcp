import fs from 'fs';
import path from 'path';
import { logger } from '@/utils/logger';

export type LlmProviderId = 'hf' | 'openai' | 'anthropic';
const PROVIDERS: readonly LlmProviderId[] = ['hf', 'openai', 'anthropic'];

/** Default model per provider — used only when no model env var is set. */
const DEFAULT_MODELS: Record<LlmProviderId, string> = {
  hf: 'openai/gpt-oss-120b',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-opus-4-8',
};

const MAX_STR = 200;
const MAX_TAGS = 50;

/** Runtime-tunable settings for the cerveau, editable from the web Settings page. */
export interface CerveauSettings {
  llm: { provider: LlmProviderId; model: string };
  retrieval: { topK: number; rerank: boolean; hybrid: boolean };
  filters: { folder: string; tags: string[] };
}

const MAX_TOP_K = 30;

/** Seed defaults from env so a fresh deploy behaves exactly like the env-only setup. */
export function envDefaultSettings(): CerveauSettings {
  const provider: LlmProviderId =
    process.env.LLM_BASE_URL && process.env.LLM_API_KEY
      ? 'hf'
      : process.env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : process.env.OPENAI_API_KEY
          ? 'openai'
          : 'hf';
  const model =
    process.env.LLM_MODEL || process.env.RAG_GENERATION_MODEL || DEFAULT_MODELS[provider];
  return {
    llm: { provider, model },
    retrieval: {
      topK: clampTopK(Number(process.env.RAG_TOP_K)) || 8,
      rerank: (process.env.RAG_RERANK || 'on').toLowerCase() !== 'off',
      hybrid: (process.env.RAG_HYBRID || 'on').toLowerCase() !== 'off',
    },
    filters: { folder: '', tags: [] },
  };
}

/**
 * Persists {@link CerveauSettings} as JSON, with an in-memory cache. Lives next
 * to the RAG index (the persistent `/data` volume), so edits survive redeploys.
 * Unknown / malformed fields in a patch are ignored — never throws on bad input.
 */
export class SettingsStore {
  private cache: CerveauSettings | null = null;

  constructor(private readonly file: string) {}

  get(): CerveauSettings {
    if (!this.cache) this.cache = this.load();
    return this.cache;
  }

  /**
   * Merge a (partial, untrusted) patch into the settings. The in-memory cache
   * is updated regardless; `persisted` reports whether the write to disk
   * succeeded (false ⇒ applied for this process but lost on restart).
   */
  update(patch: unknown): { settings: CerveauSettings; persisted: boolean } {
    const next = sanitize(patch, this.get());
    this.cache = next;
    const persisted = this.save(next);
    return { settings: next, persisted };
  }

  private load(): CerveauSettings {
    const defaults = envDefaultSettings();
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return sanitize(raw, defaults);
      }
    } catch (err) {
      logger.warn('Failed to read cerveau settings, using defaults', { err: String(err) });
    }
    return defaults;
  }

  private save(s: CerveauSettings): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(s, null, 2));
      return true;
    } catch (err) {
      logger.error('Failed to write cerveau settings', { err: String(err) });
      return false;
    }
  }
}

export function createSettingsStore(): SettingsStore {
  const dir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');
  return new SettingsStore(path.join(dir, 'cerveau-settings.json'));
}

let singleton: SettingsStore | null = null;
/** Process-wide settings store, shared by the LLM completer, RAG retrieval, and the API. */
export function getSettingsStore(): SettingsStore {
  if (!singleton) singleton = createSettingsStore();
  return singleton;
}

function clampTopK(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(1, Math.min(MAX_TOP_K, Math.floor(n)));
}

/** Validate+clamp a patch over a base, dropping anything malformed (never throws). */
function sanitize(patch: unknown, base: CerveauSettings): CerveauSettings {
  const p = (patch ?? {}) as Record<string, any>;
  const llm = (p.llm ?? {}) as Record<string, any>;
  const retrieval = (p.retrieval ?? {}) as Record<string, any>;
  const filters = (p.filters ?? {}) as Record<string, any>;

  const provider = PROVIDERS.includes(llm.provider) ? (llm.provider as LlmProviderId) : base.llm.provider;
  const model =
    typeof llm.model === 'string' && llm.model.trim()
      ? llm.model.trim().slice(0, MAX_STR)
      : base.llm.model;

  return {
    llm: { provider, model },
    retrieval: {
      topK: clampTopK(Number(retrieval.topK)) || base.retrieval.topK,
      rerank: typeof retrieval.rerank === 'boolean' ? retrieval.rerank : base.retrieval.rerank,
      hybrid: typeof retrieval.hybrid === 'boolean' ? retrieval.hybrid : base.retrieval.hybrid,
    },
    filters: {
      folder:
        typeof filters.folder === 'string' ? filters.folder.trim().slice(0, MAX_STR) : base.filters.folder,
      tags: Array.isArray(filters.tags)
        ? filters.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, MAX_TAGS)
        : base.filters.tags,
    },
  };
}
