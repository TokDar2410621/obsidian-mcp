import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureLogger } from '@/utils/logger';
import { createFileAuthStore } from '@/services/auth/stores';
import type { AccessTokenData, SessionData } from '@/services/auth/stores';

let dir: string;

beforeAll(() => {
  // The store logs on construction; configure a discard sink so it doesn't throw.
  configureLogger({ stream: { write: () => true } as unknown as NodeJS.WriteStream });
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('FileAuthStore persistence', () => {
  it('reloads sessions and tokens from disk (survives a simulated redeploy)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'auth-store-'));
    const file = path.join(dir, 'auth.json');
    const now = Date.now();

    const store = createFileAuthStore(file);
    const session: SessionData = {
      sessionId: 'sess-1',
      authenticated: true,
      createdAt: now,
      expiresAt: now + 60_000,
    };
    await store.setSession(session);

    const token: AccessTokenData = {
      token: 'access-1',
      refreshToken: 'refresh-1',
      createdAt: now,
      expiresAt: now + 60_000,
      scope: 'mcp',
    };
    await store.setAccessToken(token);

    // A fresh store on the same file is what a redeploy looks like.
    const reloaded = createFileAuthStore(file);
    expect((await reloaded.getSession('sess-1'))?.authenticated).toBe(true);
    expect((await reloaded.getAccessToken('access-1'))?.scope).toBe('mcp');
    expect((await reloaded.getRefreshToken('refresh-1'))?.accessToken).toBe('access-1');
  });

  it('drops expired sessions/access tokens on reload but keeps refresh tokens', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'auth-store-'));
    const file = path.join(dir, 'auth.json');
    const now = Date.now();

    const store = createFileAuthStore(file);
    await store.setSession({
      sessionId: 'expired',
      authenticated: true,
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
    });
    await store.setAccessToken({
      token: 'old-access',
      refreshToken: 'refresh-keep',
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
      scope: 'mcp',
    });

    const reloaded = createFileAuthStore(file);
    expect(await reloaded.getSession('expired')).toBeNull();
    expect(await reloaded.getAccessToken('old-access')).toBeNull();
    // The refresh token outlives the access token so silent re-auth still works.
    expect((await reloaded.getRefreshToken('refresh-keep'))?.accessToken).toBe('old-access');
  });
});
