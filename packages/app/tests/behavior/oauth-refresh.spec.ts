import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});
import {
  createAuthorizationCode,
  exchangeCodeForToken,
  refreshAccessToken,
  clearRefreshGrace,
  validateAccessToken,
  getAuthStore,
  setAuthStore,
} from '@/services/auth';
import { createInMemoryAuthStore } from '@/services/auth/stores';

const CLIENT = 'obsidian-mcp-client';
const CB = 'http://localhost/callback';

async function grant(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const code = await createAuthorizationCode('verifier', 'plain', CB);
  const t = await exchangeCodeForToken(code, 'verifier', CB, CLIENT);
  if (!t) throw new Error('exchange failed');
  return t;
}

describe('OAuth refresh : le connecteur ne meurt plus toutes les heures', () => {
  beforeEach(() => {
    setAuthStore(createInMemoryAuthStore());
    clearRefreshGrace();
  });

  it('le refresh survit a l expiration du token (le bug qui tuait le connecteur)', async () => {
    const t = await grant();
    // Le scenario reel : le token expire, une requete arrive (validate), puis
    // le client tente son refresh. Avant le fix : validate supprimait le token
    // ET, par cascade du store, le refresh token : mort du connecteur.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + t.expiresIn * 1000 + 60_000);
      expect(await validateAccessToken(t.accessToken)).toBe(false); // expire
      const r = await refreshAccessToken(t.refreshToken);
      expect(r).not.toBeNull(); // le refresh token a survecu
      expect(await validateAccessToken(r!.accessToken)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('la suppression explicite d un token revoque bien son refresh (comportement voulu)', async () => {
    const t = await grant();
    await getAuthStore().deleteAccessToken(t.accessToken); // revocation volontaire
    expect(await refreshAccessToken(t.refreshToken)).toBeNull();
  });

  it('le refresh nominal marche toujours', async () => {
    const t = await grant();
    const r = await refreshAccessToken(t.refreshToken);
    expect(r).not.toBeNull();
    expect(await validateAccessToken(r!.accessToken)).toBe(true);
  });

  it('un refresh token inconnu echoue proprement', async () => {
    expect(await refreshAccessToken('jamais-vu')).toBeNull();
  });

  it("la duree de vie par defaut se compte en jours, plus en heures", async () => {
    const t = await grant();
    expect(t.expiresIn).toBeGreaterThan(7 * 24 * 3600);
  });

  it('un retry du meme refresh token dans la fenetre de grace recoit la MEME paire (reponse perdue)', async () => {
    // Le tueur residuel du connecteur (matin du 2026-07-10) : le client perd la
    // reponse du refresh (timeout, course), rejoue le meme refresh token, et
    // recevait invalid_grant : deconnexion. La grace rend le retry idempotent.
    const t = await grant();
    const r1 = await refreshAccessToken(t.refreshToken);
    expect(r1).not.toBeNull();
    const r2 = await refreshAccessToken(t.refreshToken); // replay immediat
    expect(r2).toEqual(r1);
    expect(await validateAccessToken(r1!.accessToken)).toBe(true);
  });

  it('apres la fenetre de grace, le vieux refresh token est mort et la nouvelle paire vit', async () => {
    const t = await grant();
    const r1 = await refreshAccessToken(t.refreshToken);
    expect(r1).not.toBeNull();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000); // au-dela des 5 min de grace
      expect(await refreshAccessToken(t.refreshToken)).toBeNull(); // rotation reelle
      expect(await refreshAccessToken(r1!.refreshToken)).not.toBeNull(); // la paire courante marche
    } finally {
      vi.useRealTimers();
    }
  });
});
