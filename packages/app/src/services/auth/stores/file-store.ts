import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import type { AuthStore } from './types.js';
import { InMemoryAuthStore } from './in-memory-store.js';
import { logger } from '@/utils/logger';

interface PersistedState {
  sessions?: unknown[];
  authCodes?: unknown[];
  accessTokens?: unknown[];
  refreshTokens?: unknown[];
}

/**
 * Auth store that keeps the fast in-memory maps but mirrors them to a JSON file
 * after every mutation, and reloads them on startup. Point it at a path on a
 * Railway Volume (or any persistent disk) via `AUTH_STORE_PATH` so OAuth sessions
 * and tokens survive redeploys — otherwise every deploy wipes the in-memory store
 * and the connector has to be re-authorized.
 *
 * Expired sessions / auth codes / access tokens are dropped on load; refresh
 * tokens are kept (they outlive access tokens and drive silent re-auth).
 */
export class FileAuthStore extends InMemoryAuthStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      logger.info('No existing auth store file; starting empty', { path: this.filePath });
      return;
    }

    try {
      const data = JSON.parse(raw) as PersistedState;
      const now = Date.now();

      for (const s of (data.sessions ?? []) as any[]) {
        if (s?.sessionId && s.expiresAt > now) this.sessions.set(s.sessionId, s);
      }
      for (const c of (data.authCodes ?? []) as any[]) {
        if (c?.code && c.expiresAt > now) this.authCodes.set(c.code, c);
      }
      for (const t of (data.accessTokens ?? []) as any[]) {
        if (t?.token && t.expiresAt > now) this.accessTokens.set(t.token, t);
      }
      for (const r of (data.refreshTokens ?? []) as any[]) {
        if (r?.refreshToken) this.refreshTokens.set(r.refreshToken, r);
      }

      logger.info('Loaded persistent auth store', {
        path: this.filePath,
        sessions: this.sessions.size,
        accessTokens: this.accessTokens.size,
        refreshTokens: this.refreshTokens.size,
      });
    } catch (error) {
      logger.error('Failed to parse auth store file; starting empty', {
        path: this.filePath,
        error,
      });
    }
  }

  protected async onChange(): Promise<void> {
    const json = JSON.stringify({
      sessions: [...this.sessions.values()],
      authCodes: [...this.authCodes.values()],
      accessTokens: [...this.accessTokens.values()],
      refreshTokens: [...this.refreshTokens.values()],
    });

    // Serialize writes so concurrent mutations never interleave on disk.
    this.writeChain = this.writeChain.then(
      () => this.atomicWrite(json),
      () => this.atomicWrite(json),
    );
    return this.writeChain;
  }

  private async atomicWrite(json: string): Promise<void> {
    try {
      const tmp = `${this.filePath}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(tmp, json, 'utf-8');
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      // Never let a persistence failure break the auth flow — log and continue
      // serving from memory.
      logger.error('Failed to persist auth store', { path: this.filePath, error });
    }
  }
}

export function createFileAuthStore(filePath: string): AuthStore {
  logger.info('Creating file-backed auth store', { path: filePath });
  return new FileAuthStore(filePath);
}
