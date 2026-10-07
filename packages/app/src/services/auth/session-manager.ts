import crypto from 'crypto';
import { getAuthStore } from './auth-store-singleton.js';
import type { SessionData } from './stores/types.js';
import { logger } from '@/utils/logger';

const SESSION_EXPIRY_MS = Number(process.env.SESSION_EXPIRY_MS || 24 * 60 * 60 * 1000);

export type Session = SessionData;

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createSession(): Promise<string> {
  try {
    const sessionId = generateSessionId();
    const now = Date.now();

    const session: Session = {
      sessionId,
      authenticated: false,
      createdAt: now,
      expiresAt: now + SESSION_EXPIRY_MS,
    };

    const store = getAuthStore();
    await store.setSession(session);

    logger.debug('Session created', {
      sessionId,
      expiresAt: session.expiresAt,
    });

    return sessionId;
  } catch (error) {
    logger.error('Error creating session', { error });
    throw error;
  }
}

export async function getSession(sessionId: string): Promise<Session | null> {
  try {
    if (!sessionId) {
      return null;
    }

    const store = getAuthStore();
    const session = await store.getSession(sessionId);

    if (!session) {
      return null;
    }

    if (Date.now() > session.expiresAt) {
      await store.deleteSession(sessionId);
      return null;
    }

    return session;
  } catch (error) {
    logger.error('Error getting session', { error });
    return null;
  }
}

/**
 * Qui a le droit de se connecter. Rend `{}` pour l'humain unique de l'instance
 * perso, `{ inviteId }` pour un ami sur l'instance invitee, null sinon.
 */
export type VerificateurConnexion = (token: string) => Promise<{ inviteId?: string } | null>;

/** Instance perso : le seul secret valable est PERSONAL_AUTH_TOKEN. */
export const verifierJetonPersonnel: VerificateurConnexion = async providedToken => {
  const validToken = process.env.PERSONAL_AUTH_TOKEN;

  if (!validToken) {
    logger.error('PERSONAL_AUTH_TOKEN not configured');
    return null;
  }

  if (typeof providedToken !== 'string') {
    return null;
  }

  const validBuffer = Buffer.from(validToken);
  const providedBuffer = Buffer.from(providedToken);

  if (validBuffer.length !== providedBuffer.length) {
    return null;
  }

  return crypto.timingSafeEqual(validBuffer, providedBuffer) ? {} : null;
};

export async function authenticateSession(
  sessionId: string,
  providedToken: string,
  verifier: VerificateurConnexion = verifierJetonPersonnel,
): Promise<boolean> {
  const session = await getSession(sessionId);

  if (!session) {
    return false;
  }

  const identite = typeof providedToken === 'string' ? await verifier(providedToken) : null;
  const isValid = identite !== null;

  if (isValid) {
    const updatedSession: Session = {
      ...session,
      authenticated: true,
      ...(identite.inviteId ? { inviteId: identite.inviteId } : {}),
    };
    const store = getAuthStore();
    await store.setSession(updatedSession);

    logger.info('Session authenticated successfully', {
      sessionId,
    });
  } else {
    logger.warn('Session authentication failed', {
      sessionId,
    });
  }

  return isValid;
}

export async function storePendingAuthRequest(
  sessionId: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: 'S256' | 'plain',
  state?: string,
): Promise<boolean> {
  try {
    const session = await getSession(sessionId);

    if (!session) {
      logger.debug('Session not found', { sessionId });
      return false;
    }

    const updatedSession: Session = {
      ...session,
      pendingAuthRequest: {
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
      },
    };

    const store = getAuthStore();
    await store.setSession(updatedSession);

    return true;
  } catch (error) {
    logger.error('Error storing pending auth request', { error });
    return false;
  }
}

export async function consumePendingAuthRequest(
  sessionId: string,
): Promise<Session['pendingAuthRequest'] | null> {
  const session = await getSession(sessionId);

  if (!session || !session.authenticated || !session.pendingAuthRequest) {
    return null;
  }

  const request = session.pendingAuthRequest;

  const updatedSession: Session = {
    ...session,
    pendingAuthRequest: undefined,
  };

  const store = getAuthStore();
  await store.setSession(updatedSession);

  return request;
}

export async function isAuthenticated(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  return session?.authenticated || false;
}

export async function destroySession(sessionId: string): Promise<void> {
  const store = getAuthStore();
  await store.deleteSession(sessionId);
}
