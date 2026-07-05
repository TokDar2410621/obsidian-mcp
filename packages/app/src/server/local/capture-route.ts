import type { Express, Request, Response } from 'express';
import type { VaultManager } from '@/services/vault-manager';
import { logger } from '@/utils/logger';

/**
 * Frictionless capture inbox. `POST /capture` appends an idea or a URL to a
 * dated inbox note, so a phone Share button or a browser bookmarklet can drop
 * something into the cerveau without opening an agent. The VaultManager commits
 * and pushes; the webhook then reindexes and the objective sweep runs, and the
 * daily ingest agent distills, files and links the raw items later.
 *
 * Gated by CAPTURE_TOKEN (the token is the secret, so CORS is open: the
 * bookmarklet runs on arbitrary sites). Disabled unless CAPTURE_TOKEN is set.
 */

const INBOX_DIR = '01-raw/inbox';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-capture-token',
};

const day = () => new Date().toISOString().slice(0, 10);
const hm = () => new Date().toISOString().slice(11, 16);
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

function inboxHeader(date: string): string {
  return [
    '---',
    'type: raw',
    'tags: [inbox, capture]',
    `created: ${date}`,
    '---',
    '',
    `# Capture ${date}`,
    '',
    '> Captures rapides (bouton Partager / bookmarklet). Brut. L\'agent quotidien distille, range et relie.',
    '',
  ].join('\n');
}

export function registerCaptureRoute(app: Express, vault: VaultManager): boolean {
  const token = process.env.CAPTURE_TOKEN;
  if (!token) {
    logger.info('CAPTURE_TOKEN not set — POST /capture disabled');
    return false;
  }

  app.options('/capture', (_req: Request, res: Response) => {
    res.set(CORS).status(204).end();
  });

  app.post('/capture', async (req: Request, res: Response) => {
    res.set(CORS);
    const provided =
      req.header('x-capture-token') ||
      (req.query.token as string | undefined) ||
      (req.body?.token as string | undefined);
    if (provided !== token) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const url = clean(req.body?.url ?? req.query.url);
    const title = clean(req.body?.title ?? req.query.title);
    const text = clean(req.body?.text ?? req.query.text);
    if (!url && !text) {
      res.status(400).json({ error: 'need url or text' });
      return;
    }

    // One bullet, middot separators (never an em-dash — vault style rule).
    const parts: string[] = [];
    if (url) parts.push(title ? `[${title}](${url})` : url);
    if (text && text !== url && text !== title) parts.push(text);
    const bullet = `- ${hm()} · ${parts.join(' · ')}`;

    const file = `${INBOX_DIR}/${day()}.md`;
    try {
      await vault.createDirectory(INBOX_DIR, true);
      const base = (await vault.fileExists(file))
        ? await vault.readFile(file)
        : inboxHeader(day());
      await vault.writeFile(file, `${base.replace(/\s*$/, '')}\n${bullet}\n`);
      logger.info('Capture stored', { file });
      res.status(200).json({ ok: true, file });
    } catch (error) {
      logger.error('Capture failed', { error: String(error) });
      res.status(500).json({ error: 'write failed' });
    }
  });

  logger.info('Capture route registered at POST /capture');
  return true;
}
