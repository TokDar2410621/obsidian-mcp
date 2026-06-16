import type {
  AuthStore,
  SessionData,
  AuthCodeData,
  AccessTokenData,
  RefreshTokenData,
} from './types.js';
import { logger } from '@/utils/logger';

export class InMemoryAuthStore implements AuthStore {
  protected sessions = new Map<string, SessionData>();
  protected authCodes = new Map<string, AuthCodeData>();
  protected accessTokens = new Map<string, AccessTokenData>();
  protected refreshTokens = new Map<string, RefreshTokenData>();

  /**
   * Invoked after every mutation. No-op for the in-memory store; persistent
   * subclasses (e.g. FileAuthStore) override it to flush state to durable storage.
   */
  protected async onChange(): Promise<void> {}

  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return {
      ...session,
      pendingAuthRequest: session.pendingAuthRequest
        ? { ...session.pendingAuthRequest }
        : undefined,
    };
  }

  async setSession(session: SessionData): Promise<void> {
    const copy: SessionData = {
      ...session,
      pendingAuthRequest: session.pendingAuthRequest
        ? { ...session.pendingAuthRequest }
        : undefined,
    };
    this.sessions.set(session.sessionId, copy);
    await this.onChange();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.onChange();
  }

  async getAuthCode(code: string): Promise<AuthCodeData | null> {
    return this.authCodes.get(code) || null;
  }

  async setAuthCode(data: AuthCodeData): Promise<void> {
    this.authCodes.set(data.code, { ...data });
    await this.onChange();
  }

  async deleteAuthCode(code: string): Promise<void> {
    this.authCodes.delete(code);
    await this.onChange();
  }

  async getAccessToken(token: string): Promise<AccessTokenData | null> {
    return this.accessTokens.get(token) || null;
  }

  async setAccessToken(data: AccessTokenData): Promise<void> {
    this.accessTokens.set(data.token, { ...data });
    this.refreshTokens.set(data.refreshToken, {
      refreshToken: data.refreshToken,
      accessToken: data.token,
    });
    await this.onChange();
  }

  async deleteAccessToken(token: string): Promise<void> {
    const data = this.accessTokens.get(token);
    if (data) {
      this.refreshTokens.delete(data.refreshToken);
    }
    this.accessTokens.delete(token);
    await this.onChange();
  }

  async getRefreshToken(refreshToken: string): Promise<RefreshTokenData | null> {
    return this.refreshTokens.get(refreshToken) || null;
  }

  async setRefreshToken(data: RefreshTokenData): Promise<void> {
    this.refreshTokens.set(data.refreshToken, { ...data });
    await this.onChange();
  }

  async deleteRefreshToken(refreshToken: string): Promise<void> {
    this.refreshTokens.delete(refreshToken);
    await this.onChange();
  }
}

export function createInMemoryAuthStore(): AuthStore {
  logger.info('Creating in-memory auth store');
  return new InMemoryAuthStore();
}
