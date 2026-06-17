import { Pool } from 'pg';
import type {
  AuthStore,
  SessionData,
  AuthCodeData,
  AccessTokenData,
  RefreshTokenData,
} from './types.js';
import { logger } from '@/utils/logger';

/**
 * Minimal subset of a `pg` Pool/Client we depend on — lets us unit-test the
 * store with a fake and keeps `pg` out of the class itself (it's only imported
 * by the factory below, never by the lambda bundle).
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

type Kind = 'session' | 'auth_code' | 'access_token' | 'refresh_token';

/**
 * Postgres-backed auth store. OAuth sessions and tokens live in a single
 * `mcp_auth_store(kind, id, data jsonb, expires_at)` table, so they survive
 * redeploys (the in-memory store loses them on every restart, forcing the
 * connector to be re-authorized). Point the server at a database with
 * `DATABASE_URL` (e.g. a Railway Postgres plugin) to enable it.
 *
 * Expired sessions / auth codes / access tokens are pruned on startup; refresh
 * tokens have no expiry and are kept so silent re-auth keeps working.
 */
export class PostgresAuthStore implements AuthStore {
  private readonly ready: Promise<void>;

  constructor(private readonly sql: SqlClient) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS mcp_auth_store (
         kind        TEXT   NOT NULL,
         id          TEXT   NOT NULL,
         data        JSONB  NOT NULL,
         expires_at  BIGINT,
         PRIMARY KEY (kind, id)
       )`,
    );
    // Drop rows that are already expired (refresh tokens have expires_at IS NULL).
    await this.sql.query(`DELETE FROM mcp_auth_store WHERE expires_at IS NOT NULL AND expires_at < $1`, [
      Date.now(),
    ]);
    logger.info('Postgres auth store ready');
  }

  private async upsert(kind: Kind, id: string, data: unknown, expiresAt: number | null): Promise<void> {
    await this.sql.query(
      `INSERT INTO mcp_auth_store (kind, id, data, expires_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [kind, id, JSON.stringify(data), expiresAt],
    );
  }

  private async getRow<T>(kind: Kind, id: string): Promise<T | null> {
    const res = await this.sql.query(`SELECT data FROM mcp_auth_store WHERE kind = $1 AND id = $2`, [
      kind,
      id,
    ]);
    if (!res.rows[0]) return null;
    const data = res.rows[0].data;
    // node-postgres parses jsonb to an object, but tolerate a string just in case.
    return (typeof data === 'string' ? JSON.parse(data) : data) as T;
  }

  private async del(kind: Kind, id: string): Promise<void> {
    await this.sql.query(`DELETE FROM mcp_auth_store WHERE kind = $1 AND id = $2`, [kind, id]);
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    await this.ready;
    return this.getRow<SessionData>('session', sessionId);
  }

  async setSession(session: SessionData): Promise<void> {
    await this.ready;
    await this.upsert('session', session.sessionId, session, session.expiresAt);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ready;
    await this.del('session', sessionId);
  }

  async getAuthCode(code: string): Promise<AuthCodeData | null> {
    await this.ready;
    return this.getRow<AuthCodeData>('auth_code', code);
  }

  async setAuthCode(data: AuthCodeData): Promise<void> {
    await this.ready;
    await this.upsert('auth_code', data.code, data, data.expiresAt);
  }

  async deleteAuthCode(code: string): Promise<void> {
    await this.ready;
    await this.del('auth_code', code);
  }

  async getAccessToken(token: string): Promise<AccessTokenData | null> {
    await this.ready;
    return this.getRow<AccessTokenData>('access_token', token);
  }

  async setAccessToken(data: AccessTokenData): Promise<void> {
    await this.ready;
    await this.upsert('access_token', data.token, data, data.expiresAt);
    await this.upsert(
      'refresh_token',
      data.refreshToken,
      { refreshToken: data.refreshToken, accessToken: data.token },
      null,
    );
  }

  async deleteAccessToken(token: string): Promise<void> {
    await this.ready;
    const data = await this.getRow<AccessTokenData>('access_token', token);
    if (data) {
      await this.del('refresh_token', data.refreshToken);
    }
    await this.del('access_token', token);
  }

  async getRefreshToken(refreshToken: string): Promise<RefreshTokenData | null> {
    await this.ready;
    return this.getRow<RefreshTokenData>('refresh_token', refreshToken);
  }

  async setRefreshToken(data: RefreshTokenData): Promise<void> {
    await this.ready;
    await this.upsert('refresh_token', data.refreshToken, data, null);
  }

  async deleteRefreshToken(refreshToken: string): Promise<void> {
    await this.ready;
    await this.del('refresh_token', refreshToken);
  }
}

/**
 * Build a Postgres auth store from a connection string. This module is imported
 * only from the HTTP entrypoint (never from the stores barrel that the lambda
 * bundles), so `pg` stays out of the AWS build — the lambda keeps using DynamoDB.
 */
export function createPostgresAuthStore(connectionString: string): AuthStore {
  const pool = new Pool({ connectionString });
  logger.info('Creating Postgres auth store');
  return new PostgresAuthStore(pool as SqlClient);
}
