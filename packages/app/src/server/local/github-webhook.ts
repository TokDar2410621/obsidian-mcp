import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import type { RagService } from '@/services/rag';
import type { GraphService } from '@/services/graph';
import type { ObjectiveSweepService } from '@/services/objectives/objective-sweep';
import type { CaptureLinkSweepService } from '@/services/captures/capture-link-sweep';
import type { VaultManager } from '@/services/vault-manager';
import type { ReflectionService } from '@/services/reflection/reflection-service';
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

const ECHOS_FILE = '08-auto/_echos.md';
const MAX_ECHO_SECTIONS = 20;
const MAX_TRIGGER_FILES = 10;

/**
 * Changed markdown notes of a push payload (added + modified across commits),
 * excluding the agents' own outputs (08-auto) so echoes never echo themselves.
 */
export function changedNotesOf(payload: unknown): string[] {
  const p = payload as { commits?: Array<{ added?: string[]; modified?: string[] }> } | null;
  const out = new Set<string>();
  for (const c of p?.commits ?? []) {
    for (const f of [...(c.added ?? []), ...(c.modified ?? [])]) {
      if (typeof f !== 'string' || !f.endsWith('.md')) continue;
      if (f.startsWith('08-auto/') || f.startsWith('_templates/') || f.startsWith('99-graphify-out/'))
        continue;
      out.add(f);
    }
  }
  return [...out].slice(0, MAX_TRIGGER_FILES);
}

/** Render the dated echoes section (newest first, capped). Pure, testable. */
export function renderEchos(
  existing: string,
  stamp: string,
  triggers: string[],
  echoes: Array<{ file: string; score: number }>,
): string {
  const header = [
    '---',
    'type: note',
    'tags: [auto, echos]',
    '---',
    '',
    '# Échos (activation associative, auto)',
    '',
    "> À chaque écriture dans le vault, les notes voisines dans le graphe se",
    "> réveillent (2 sauts, décroissance). Les penseurs lisent ces échos comme",
    "> matière à croisements : c'est l'association d'idées du cerveau.",
    '',
  ].join('\n');
  const lines = echoes.map(e => `- [[${e.file.replace(/\.md$/, '')}]] (${e.score})`);
  const section = `\n## ${stamp} · réveillé par : ${triggers
    .map(t => t.replace(/\.md$/, ''))
    .join(', ')}\n\n${lines.join('\n')}\n`;
  const idx = existing.indexOf('\n## ');
  const body = idx >= 0 ? existing.slice(idx) : '';
  const sections = (section + body).split(/\n(?=## )/).slice(0, MAX_ECHO_SECTIONS);
  return header + sections.join('\n');
}

/**
 * Mount `POST /webhook/github`. On a verified `push` event it triggers an
 * incremental reindex in the background and acknowledges immediately (GitHub
 * expects a fast 2xx). After the graph rebuild, event-driven cognition runs:
 * spreading activation writes the changed notes' "echoes" (graph neighbours)
 * for the thinkers, and, when enabled, a targeted reflection micro-wake fires.
 * No-ops (and logs) if `GITHUB_WEBHOOK_SECRET` is unset.
 */
export function registerGithubWebhook(
  app: Express,
  rag: RagService,
  graph?: GraphService | null,
  sweep?: ObjectiveSweepService | null,
  captureLink?: CaptureLinkSweepService | null,
  organs?: { vault?: VaultManager | null; reflection?: ReflectionService | null },
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.info('GITHUB_WEBHOOK_SECRET not set — POST /webhook/github disabled');
    return false;
  }
  const vault = organs?.vault ?? null;
  const reflection = organs?.reflection ?? null;

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
      const changed = changedNotesOf(req.body);
      logger.info('Webhook push received', {
        changed: changed.length,
        files: changed.slice(0, 3),
      });
      rag
        .refresh()
        .then(result => {
          logger.info('RAG reindex (webhook) complete', result);
          // Deterministic objective sweep on the fresh index: every new/changed
          // note is confronted with the open objectives' unmet conditions
          // (propose-only, dedup'd — a no-op push converges immediately).
          return sweep
            ?.runSweep()
            .then(s => logger.info('Objective sweep (webhook) done', { ...s }))
            .catch(error => logger.error('Objective sweep (webhook) failed', { error: String(error) }));
        })
        // Link fresh captures to the project each could advance, react in seconds
        // to a phone capture (propose-only, dedup'd, one ntfy per run with news).
        .then(() =>
          captureLink
            ?.runSweep()
            .then(s => logger.info('Capture link sweep (webhook) done', { ...s }))
            .catch(error =>
              logger.error('Capture link sweep (webhook) failed', { error: String(error) }),
            ),
        )
        .then(() => graph?.build())
        .then(g => {
          if (g) logger.info('Graph rebuild (webhook) complete', g);
        })
        // Event-driven cognition (diagnostic gaps #5/#6): thinking is triggered
        // by what just happened, not only by the clock. Deterministic and free:
        // spreading activation over the fresh graph writes the echoes the
        // thinkers (night thinker on PC2, server reflection) consume.
        .then(async () => {
          if (changed.length === 0) return; // routine server-state push
          if (!vault || !graph) {
            logger.info('Echoes skipped (vault or graph organ not wired)');
            return;
          }
          try {
            const echoes = await graph.echoesFor(changed, 5);
            if (echoes.length === 0) {
              logger.info('Echoes: none found for changed notes', { files: changed });
              return;
            }
            const existing = await vault.readFile(ECHOS_FILE).catch(() => '');
            const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
            await vault.writeFile(ECHOS_FILE, renderEchos(existing, stamp, changed, echoes));
            logger.info('Echoes written (spreading activation)', {
              triggers: changed.length,
              echoes: echoes.length,
            });
          } catch (error) {
            logger.error('Echo computation failed', { error: String(error) });
          }
        })
        // Optional micro-wake: a push that touches real notes can trigger one
        // reflection cycle (the daily circuit-breaker in runCycle caps cost to
        // at most one cycle per day). Opt-in via EVENT_REFLECTION=on.
        .then(() => {
          if (!reflection || changed.length === 0) return;
          if ((process.env.EVENT_REFLECTION ?? 'off') !== 'on') return;
          return reflection
            .runCycle()
            .then(r => logger.info('Reflection micro-wake (webhook) done', { ...r }))
            .catch(error =>
              logger.error('Reflection micro-wake (webhook) failed', { error: String(error) }),
            );
        })
        .catch(error => logger.error('RAG/graph reindex (webhook) failed', { error: String(error) }));
    }
  });

  logger.info('GitHub webhook registered at POST /webhook/github');
  return true;
}
