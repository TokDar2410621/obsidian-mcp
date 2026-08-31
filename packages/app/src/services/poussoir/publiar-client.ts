import { logger } from '@/utils/logger';

/**
 * Minimal Publiar REST client for the poussoir "Accepter" chain. Same surface
 * the publiar-mcp package calls (api.publiar.app/api, Bearer PUBLIAR_API_KEY):
 *  - POST /linkedin/v3/visual/generate/  {spec}            -> PNG bytes
 *  - POST /linkedin/v3/publish/          {content, ...}    -> {post_urn, ...}
 *
 * Publishing goes OUT: it only ever runs from a route where Darius just tapped
 * the confirmation button, never from a cron. The tap IS the validation the
 * vault rule requires ("le cerveau prepare, Darius envoie").
 */

const DEFAULT_API = 'https://api.publiar.app/api';

export interface PublishResult {
  post_urn?: string;
  [k: string]: unknown;
}

export class PubliarClient {
  private readonly base: string;
  private readonly key: string | undefined;

  constructor() {
    this.base = (process.env.PUBLIAR_API_URL || DEFAULT_API).replace(/\/$/, '');
    this.key = process.env.PUBLIAR_API_KEY;
  }

  /** Without a key the Accepter surface degrades to an explanation page. */
  configured(): boolean {
    return Boolean(this.key);
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.key}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** Render a LeadMagnetVisualSpec to PNG bytes. Throws with the server text on 4xx/5xx. */
  async renderVisual(spec: Record<string, unknown>): Promise<Buffer> {
    const r = await fetch(`${this.base}/linkedin/v3/visual/generate/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ spec }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`render_visual ${r.status}: ${txt.slice(0, 300)}`);
    }
    return Buffer.from(await r.arrayBuffer());
  }

  /**
   * Publish NOW on LinkedIn. Two-phase upstream: we always send confirmed=true
   * because this method is only reachable from the explicit confirmation tap.
   */
  async publish(args: {
    content: string;
    image_base64?: string;
    first_comment?: string;
  }): Promise<PublishResult> {
    const r = await fetch(`${this.base}/linkedin/v3/publish/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...args, confirmed: true }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`publish ${r.status}: ${txt.slice(0, 300)}`);
    try {
      return JSON.parse(txt) as PublishResult;
    } catch (error) {
      logger.warn('publiar publish: non-JSON response', { error: String(error) });
      return {};
    }
  }
}
