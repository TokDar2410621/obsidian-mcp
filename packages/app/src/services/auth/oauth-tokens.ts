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

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  const store = getAuthStore();
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
  // No strict rotation on purpose: if the client loses the response and
  // retries with the same refresh token, a deleted token would kill the
  // connector (the exact failure this fix removes). Single-user personal
  // server: availability wins.

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

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_EXPIRY / 1000),
  };
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
