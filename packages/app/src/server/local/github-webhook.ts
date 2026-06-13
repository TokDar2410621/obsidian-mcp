import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import type { RagService } from '@/services/rag';
import { logger } from '@/utils/logger';

/**
 * Verify a GitHub webhook HMAC signature against the raw request body.
 * GitHub signs the raw bytes, so the caller must capture them before JSON
 * parsing (see the `express.json({ verify })` hook in http.ts).
 */
export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);
  return received.length === computed.length && crypto.timingSafeEqual(received, computed);
}

/**
 * Mount `POST /webhook/github`. On a verified `push` event it triggers an
 * incremental reindex in the background and acknowledges immediately (GitHub
 * expects a fast 2xx). No-ops (and logs) if `GITHUB_WEBHOOK_SECRET` is unset.
 */
export function registerGithubWebhook(app: Express, rag: RagService): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.info('GITHUB_WEBHOOK_SECRET not set — POST /webhook/github disabled');
    return false;
  }

  app.post('/webhook/github', (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: 'missing raw body' });
      return;
    }
    if (!verifyGithubSignature(rawBody, req.header('x-hub-signature-256'), secret)) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const event = req.header('x-github-event');
    res.status(202).json({ status: 'accepted', event });

    if (event === 'push') {
      rag
        .refresh()
        .then(result => logger.info('RAG reindex (webhook) complete', result))
        .catch(error => logger.error('RAG reindex (webhook) failed', { error: String(error) }));
    }
  });

  logger.info('GitHub webhook registered at POST /webhook/github');
  return true;
}
