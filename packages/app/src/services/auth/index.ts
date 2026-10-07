export {
  createSession,
  getSession,
  authenticateSession,
  storePendingAuthRequest,
  consumePendingAuthRequest,
  isAuthenticated,
  destroySession,
  verifierJetonPersonnel,
  type Session,
  type VerificateurConnexion,
} from './session-manager.js';

export {
  createAuthorizationCode,
  exchangeCodeForToken,
  refreshAccessToken,
  clearRefreshGrace,
  validateAccessToken,
  getValidAccessToken,
  revokeToken,
  type AccepterRafraichissement,
  validateClientCredentials,
} from './oauth-tokens.js';

export { getAuthStore, setAuthStore } from './auth-store-singleton.js';
export {
  createInMemoryAuthStore,
  createFileAuthStore,
  createDynamoDbAuthStore,
  type DynamoDbAuthStoreOptions,
} from './stores/index.js';

export { generateSecureToken, verifyCodeChallenge } from './pkce.js';
