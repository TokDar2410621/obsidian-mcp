import { getAuthStore } from './auth-store-singleton.js';
import { generateSecureToken, verifyCodeChallenge } from './pkce.js';
import { logger } from '@/utils/logger';

const AUTH_CODE_EXPIRY = 10 * 60 * 1000;
// Personal single-user server: a short-lived access token buys no real security
// here and killed the connector hourly (see refreshAccessToken). 30 days by
// default, overridable via ACCESS_TOKEN_EXPIRY_MS.
const ACCESS_TOKEN_EXPIRY = Number(process.env.ACCESS_TOKEN_EXPIRY_MS || 30 * 24 * 60 * 60 * 1000);

export async function createAuthorizationCode(
  codeChallenge: string,
  codeChallengeMethod: 'S256' | 'plain',
  redirectUri: string,
): Promise<string> {
  const code = generateSecureToken();
  const now = Date.now();

  const store = getAuthStore();
  await store.setAuthCode({
    code,
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    createdAt: now,
    expiresAt: now + AUTH_CODE_EXPIRY,
  });

  return code;
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  const expectedClientId = process.env.OAUTH_CLIENT_ID || 'obsidian-mcp-client';
  if (clientId !== expectedClientId) {
    return null;
  }

  const store = getAuthStore();
  const authCode = await store.getAuthCode(code);

  if (!authCode) {
    return null;
  }

  if (Date.now() > authCode.expiresAt) {
    await store.deleteAuthCode(code);
    return null;
  }

  if (authCode.redirectUri !== redirectUri) {
    return null;
  }

  if (!verifyCodeChallenge(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
    return null;
  }

  await store.deleteAuthCode(code);

  const accessToken = generateSecureToken();
  const refreshToken = generateSecureToken();
  const now = Date.now();

  const tokenData = {
    token: accessToken,
    refreshToken,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_EXPIRY,
    scope: 'vault:read vault:write',
  };

  await store.setAccessToken(tokenData);
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_EXPIRY / 1000),
  };
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Idempotent refresh retries. deleteAccessToken cascades onto the refresh
 * token that minted it (every store does), so a successful refresh strictly
 * rotates: the OLD refresh token dies at once. When the client loses the
 * response (timeout, race between two refreshes), its retry replays the old
 * token and got `invalid_grant` → the connector died needing re-authorization
 * (seen the morning of 2026-07-10 despite the TTL fix). Within this grace
 * window, a replay of a just-consumed refresh token re-receives the SAME new
 * pair instead. In-memory: single-instance server, and the window is short.
 */
const REFRESH_GRACE_MS = Number(process.env.REFRESH_GRACE_MS || 5 * 60 * 1000);
const recentRotations = new Map<string, { response: RefreshResponse; rotatedAt: number }>();

/** Test hook: forget past rotations. */
export function clearRefreshGrace(): void {
  recentRotations.clear();
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse | null> {
  // A replay of a refresh token consumed moments ago is a lost-response retry,
  // not an attack: answer it with the same pair (idempotence), don't kill the grant.
  // Guard: the served pair must still be alive in the store. Without this, an
  // explicitly revoked pair (revokeToken, delete cascade) could be re-served
  // from memory during the grace window (finding of the adversarial review).
  const store = getAuthStore();
  const replay = recentRotations.get(refreshToken);
  if (replay) {
    if (
      Date.now() - replay.rotatedAt < REFRESH_GRACE_MS &&
      (await store.getRefreshToken(replay.response.refreshToken))
    ) {
      logger.info('OAuth refresh replayed within grace window: same pair served');
      return replay.response;
    }
    recentRotations.delete(refreshToken);
  }
  const refreshData = await store.getRefreshToken(refreshToken);

  if (!refreshData) {
    return null;
  }

  // The old access token may be GONE: validateAccessToken deletes it at the
  // first request after expiry. Requiring it here made every refresh that
  // arrived after that moment destroy the refresh token too, killing the
  // connector every hour (the "requires re-authorization" loop). The refresh
  // token itself is the proof of grant: tolerate a missing old access token.
  const oldTokenData = await store.getAccessToken(refreshData.accessToken);
  if (oldTokenData) {
    await store.deleteAccessToken(refreshData.accessToken);
  }

  const newAccessToken = generateSecureToken();
  const newRefreshToken = generateSecureToken();
  const now = Date.now();

  const tokenData = {
    token: newAccessToken,
    refreshToken: newRefreshToken,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_EXPIRY,
    scope: oldTokenData?.scope ?? 'vault:read vault:write',
  };

  await store.setAccessToken(tokenData);

  const response: RefreshResponse = {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_EXPIRY / 1000),
  };
  recentRotations.set(refreshToken, { response, rotatedAt: now });
  if (recentRotations.size > 64) {
    for (const [key, value] of recentRotations) {
      if (Date.now() - value.rotatedAt >= REFRESH_GRACE_MS) recentRotations.delete(key);
    }
  }
  return response;
}

export async function validateAccessToken(token: string): Promise<boolean> {
  const store = getAuthStore();
  const tokenData = await store.getAccessToken(token);

  if (!tokenData) {
    return false;
  }

  if (Date.now() > tokenData.expiresAt) {
    // Do NOT delete here: deleteAccessToken cascades onto the refresh token
    // (both stores), so cleaning an expired token used to destroy the very
    // refresh token the client was about to use. That cascade was the root of
    // the hourly "requires re-authorization" loop. The stale row is reclaimed
    // by the next successful refresh (its deleteAccessToken call).
    return false;
  }

  return true;
}

export async function revokeToken(token: string): Promise<boolean> {
  const store = getAuthStore();
  const tokenData = await store.getAccessToken(token);

  if (!tokenData) {
    return false;
  }

  await store.deleteAccessToken(token);

  return true;
}

export function validateClientCredentials(clientId: string, clientSecret: string): boolean {
  const validClientId = process.env.OAUTH_CLIENT_ID || 'obsidian-mcp-client';
  const validClientSecret = process.env.OAUTH_CLIENT_SECRET;

  if (!validClientSecret) {
    logger.error('OAUTH_CLIENT_SECRET not configured');
    return false;
  }

  return clientId === validClientId && clientSecret === validClientSecret;
}
