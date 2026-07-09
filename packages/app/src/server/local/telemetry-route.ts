import type { Express, Request, Response } from 'express';
import { logger } from '@/utils/logger';

/**
 * Workers' telemetry heartbeat (POST /heartbeat?k=TOKEN). The vault heartbeat
 * file travels over git, which is exactly what fails when a clone freezes: the
 * workers then look dead while working. This HTTP channel is their voice when
 * git is broken. In-memory only (repopulated within minutes by the workers'
 * cycles after a restart); the brief's watchdog reads it first and falls back
 * to the vault file.
 */

export interface WorkerBeat {
  last: string; // ISO datetime
  ahead?: number; // unpushed commits (-1 = unknown)
}

const beats = new Map<string, WorkerBeat>();

/** Live telemetry snapshot (worker key -> last beat). */
export function telemetrySnapshot(): Record<string, WorkerBeat> {
  return Object.fromEntries(beats);
}

export function registerTelemetryRoute(app: Express): boolean {
  const token = process.env.CAPTURE_TOKEN;
  if (!token) {
    logger.info('CAPTURE_TOKEN not set: telemetry heartbeat disabled');
    return false;
  }

  app.post('/heartbeat', (req: Request, res: Response) => {
    if ((req.query.k as string | undefined) !== token) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    const worker = String(req.body?.worker ?? '').trim();
    if (!worker || worker.length > 40) {
      res.status(400).json({ error: 'need worker' });
      return;
    }
    const ahead = Number(req.body?.ahead);
    beats.set(worker, {
      last: new Date().toISOString(),
      ...(Number.isFinite(ahead) ? { ahead } : {}),
    });
    res.status(200).json({ ok: true });
  });

  logger.info('Telemetry heartbeat registered at POST /heartbeat');
  return true;
}
