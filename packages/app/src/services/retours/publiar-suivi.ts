import { logger } from '@/utils/logger';

/**
 * Publiar REST client for the "retours du monde" organ. Read-mostly: it LISTS
 * the tracked posts and POLLS each one so comments carrying a CTA keyword
 * become engagements. It never publishes and never sends a DM.
 *
 * Paths are the ones the shipped publiar-mcp package calls (the authoritative
 * client of api.publiar.app): /linkedin/v3/published/list/, /published/{id}/,
 * /published/{id}/poll/. Impressions/reactions stats exist upstream
 * (get_post_stats on the hosted connector) but their REST path is not in that
 * mapping, so v1 deliberately leaves them out rather than guessing a route.
 */

const DEFAULT_API = 'https://api.publiar.app/api';

export interface PostSuivi {
  id: number;
  post_urn?: string;
  cta_keyword?: string;
  archetype?: string;
  status?: string;
  matched_comments_count?: number;
  dm_sent_count?: number;
  post_excerpt?: string;
  published_at?: string;
  last_polled_at?: string | null;
  [k: string]: unknown;
}

export class PubliarSuivi {
  private readonly base: string;
  private readonly key: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.base = (process.env.PUBLIAR_API_URL || DEFAULT_API).replace(/\/$/, '');
    this.key = process.env.PUBLIAR_API_KEY;
    this.fetchFn = fetchFn;
  }

  configured(): boolean {
    return Boolean(this.key);
  }

  private async requete(method: string, path: string): Promise<unknown> {
    const r = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${txt.slice(0, 200)}`);
    try {
      return JSON.parse(txt);
    } catch {
      return {};
    }
  }

  async listPublished(): Promise<PostSuivi[]> {
    const data = (await this.requete('GET', '/linkedin/v3/published/list/')) as {
      results?: PostSuivi[];
    };
    return data.results ?? [];
  }

  /**
   * Ask the backend to re-read the post's comments NOW. Returns the refreshed
   * record when the backend sends one back; a failure is the CALLER's signal
   * to fall back on the list counters instead of aborting the whole pass.
   */
  async pollNow(id: number): Promise<PostSuivi | null> {
    try {
      const data = (await this.requete('POST', `/linkedin/v3/published/${id}/poll/`)) as {
        published?: PostSuivi;
        [k: string]: unknown;
      };
      if (data && typeof data === 'object' && data.published) return data.published;
      // Certains backends rendent l'enregistrement a plat : accepte-le s'il a un id.
      if (data && typeof (data as { id?: unknown }).id === 'number') return data as unknown as PostSuivi;
      return null;
    } catch (error) {
      logger.warn('retours: poll refuse, on retombe sur les compteurs du listing', {
        id,
        error: String(error),
      });
      return null;
    }
  }
}
