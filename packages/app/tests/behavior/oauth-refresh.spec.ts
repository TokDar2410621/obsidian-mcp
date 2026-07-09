import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});
import {
  createAuthorizationCode,
  exchangeCodeForToken,
  refreshAccessToken,
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
  });

  it('le refresh survit a la suppression du token expire (le bug qui tuait le connecteur)', async () => {
    const t = await grant();
    // validateAccessToken supprime un token expire a la premiere requete :
    // on simule ce nettoyage, puis le client tente son refresh.
    await getAuthStore().deleteAccessToken(t.accessToken);

    const r = await refreshAccessToken(t.refreshToken);
    expect(r).not.toBeNull(); // avant le fix : null, refresh token detruit
    expect(await validateAccessToken(r!.accessToken)).toBe(true);
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
});
