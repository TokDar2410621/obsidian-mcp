import { beforeAll, describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { PostgresAuthStore, type SqlClient } from '@/services/auth/stores/postgres-store';

/**
 * In-memory stand-in for a `pg` Pool that understands exactly the four query
 * shapes PostgresAuthStore issues (create/prune/upsert/select/delete). Lets us
 * exercise the real store logic without a live database.
 */
class FakePostgres implements SqlClient {
  rows = new Map<string, { data: any; expires_at: number | null }>();

  async query(text: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    const t = text.trim();

    if (t.startsWith('CREATE TABLE')) return { rows: [] };

    if (t.startsWith('DELETE') && t.includes('expires_at < $1')) {
      const now = params[0] as number;
      for (const [key, value] of this.rows) {
        if (value.expires_at != null && value.expires_at < now) this.rows.delete(key);
      }
      return { rows: [] };
    }

    if (t.startsWith('INSERT')) {
      const [kind, id, dataJson, expiresAt] = params as [string, string, string, number | null];
      this.rows.set(`${kind}:${id}`, { data: JSON.parse(dataJson), expires_at: expiresAt });
      return { rows: [] };
    }

    if (t.startsWith('SELECT')) {
      const [kind, id] = params as [string, string];
      const row = this.rows.get(`${kind}:${id}`);
      return { rows: row ? [{ data: row.data }] : [] };
    }

    if (t.startsWith('DELETE')) {
      const [kind, id] = params as [string, string];
      this.rows.delete(`${kind}:${id}`);
      return { rows: [] };
    }

    return { rows: [] };
  }
}

beforeAll(() => {
  configureLogger({ stream: { write: () => true } as unknown as NodeJS.WriteStream });
});

describe('PostgresAuthStore', () => {
  it('round-trips sessions, access tokens, and the derived refresh token', async () => {
    const store = new PostgresAuthStore(new FakePostgres());
    const now = Date.now();

    await store.setSession({
      sessionId: 's1',
      authenticated: true,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    await store.setAccessToken({
      token: 'a1',
      refreshToken: 'r1',
      createdAt: now,
      expiresAt: now + 60_000,
      scope: 'mcp',
    });

    expect((await store.getSession('s1'))?.authenticated).toBe(true);
    expect((await store.getAccessToken('a1'))?.scope).toBe('mcp');
    expect((await store.getRefreshToken('r1'))?.accessToken).toBe('a1');
  });

  it('deleting an access token also removes its refresh token', async () => {
    const store = new PostgresAuthStore(new FakePostgres());
    const now = Date.now();

    await store.setAccessToken({
      token: 'a1',
      refreshToken: 'r1',
      createdAt: now,
      expiresAt: now + 60_000,
      scope: 'mcp',
    });
    await store.deleteAccessToken('a1');

    expect(await store.getAccessToken('a1')).toBeNull();
    expect(await store.getRefreshToken('r1')).toBeNull();
  });

  it('prunes expired rows on init but keeps refresh tokens', async () => {
    const db = new FakePostgres();
    const now = Date.now();
    db.rows.set('session:old', { data: { sessionId: 'old' }, expires_at: now - 1_000 });
    db.rows.set('refresh_token:keep', {
      data: { refreshToken: 'keep', accessToken: 'gone' },
      expires_at: null,
    });

    const store = new PostgresAuthStore(db);

    expect(await store.getSession('old')).toBeNull();
    expect((await store.getRefreshToken('keep'))?.accessToken).toBe('gone');
  });
});
