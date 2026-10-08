import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { configureLogger } from '@/utils/logger';
import { createInMemoryAuthStore, getAuthStore, setAuthStore } from '@/services/auth';
import { creerAppDan, type AppDan } from '@/server/guest/app';
import { InviteStoreMemoire } from '@/services/invites/invite-store';
import { messageIntrouvable } from '@/services/invites/vault-invite';
import type { EmbeddingProvider } from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';

configureLogger({ stream: process.stderr, minLevel: 'error' });

/**
 * La vie privee de Darius chez Dan, apres l'audit du coffre reel
 * (decisions Q14 et Q15 du 2026-10-07) : journal, daily, captures brutes et
 * taches caches ; coordonnees et numeros masques partout ailleurs.
 */

const COURRIEL = 'client.prospect@exemple.ca';
const TELEPHONE = '418-555-0142';
const PERMIS = 'F314509999';
const RECIT = 'RECIT-INTIME-DU-JOURNAL-5521';

class Embedder implements EmbeddingProvider {
  readonly model = 'sac-de-mots-32';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const v = new Array(32).fill(0);
      for (const mot of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        v[crypto.createHash('md5').update(mot).digest()[0] % 32] += 1;
      }
      v[31] += 0.01;
      return v;
    });
  }
}

class Perroquet implements LlmCompleter {
  readonly model = 'perroquet';
  vus: string[] = [];
  async complete(_s: string, u: string): Promise<string> {
    this.vus.push(u);
    return u;
  }
}

function coffre(): InMemoryVaultManager {
  return new InMemoryVaultManager({
    'Journal/2026-07-08.md': `# Journal\n\n${RECIT} avec ma famille. Leçon : prospecter le matin.\n`,
    '03-daily/2026-07-22.md': `# Daily\n\n${RECIT}. Permis ${PERMIS} renouvelé.\n`,
    '01-raw/career/offre.md': `# Offre\n\nPermis ${PERMIS}.\n`,
    '09-taches/_reponses.md': `# Réponses\n\n${RECIT}\n`,
    '09-archive/09-taches/vieille.md': `# Vieille tâche\n\n${RECIT}\n`,
    '05-projects/prospects/liste.md': `# Prospects\n\nContact : ${COURRIEL}, ${TELEPHONE}. Besoin : un site qui charge vite.\n`,
    '02-knowledge/vente/prospection.md': '# Prospection\n\nProspecter le matin, relancer à J+3.\n',
    '09-archive/05-projects/ancien/offre.md': `# Ancienne offre\n\nForfait mensuel ancré sur le risque. Contact : ${COURRIEL}.\n`,
    '09-archive/08-auto/proposition.md': '# Proposition archivée\n\nGeler la chasse quand le score est nul.\n',
    '09-archive/00-personnel/papiers.md': `# Papiers\n\n${RECIT}\n`,
    '09-archive/01-raw/capture.md': `# Capture\n\n${RECIT}\n`,
    '09-archive/Journal/2026-06-01.md': `# Journal\n\n${RECIT}\n`,
    '09-archive/04-people/proche.md': `# Proche\n\n${RECIT}\n`,
  });
}

async function monter(): Promise<{ app: AppDan; token: string; llm: Perroquet }> {
  const invites = new InviteStoreMemoire();
  const { invite } = await invites.creer('Paul');
  const llm = new Perroquet();
  const app = creerAppDan({
    vault: coffre(),
    invites,
    embedder: new Embedder(),
    completer: llm,
    indexDir: mkdtempSync(path.join(tmpdir(), 'dan-vie-privee-')),
    persist: false,
    baseUrl: 'http://dan.test',
    clientId: 'client-test',
    clientSecret: 'secret-test',
    quotaJour: 100,
  });
  await app.demarrer();
  const token = `tok-${crypto.randomUUID()}`;
  await getAuthStore().setAccessToken({
    token,
    refreshToken: `ref-${token}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    scope: 'vault:read',
    inviteId: invite.id,
  });
  return { app, token, llm };
}

async function appel(app: AppDan, token: string, name: string, args: Record<string, unknown>) {
  const r = await request(app.app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { corps: JSON.stringify(r.body), result: r.body.result };
}

beforeEach(() => {
  process.env.GUEST_MODE = 'true';
  process.env.OAUTH_CLIENT_ID = 'client-test';
  process.env.OAUTH_CLIENT_SECRET = 'secret-test';
  delete process.env.CERVEAU_ZONES_SENSIBLES;
  setAuthStore(createInMemoryAuthStore());
});
afterEach(() => {
  delete process.env.GUEST_MODE;
});

describe('Q15 : journal, daily, captures et taches caches', () => {
  it.each([
    'Journal/2026-07-08.md',
    '03-daily/2026-07-22.md',
    '01-raw/career/offre.md',
    '09-taches/_reponses.md',
    '09-archive/09-taches/vieille.md',
  ])('%s est introuvable', async chemin => {
    const { app, token } = await monter();
    const r = await appel(app, token, 'read-note', { path: chemin });
    expect(r.result.content[0].text).toBe(messageIntrouvable(chemin));
  });

  it('le recit intime ne sort par aucun outil, ni ne nourrit aucun prompt', async () => {
    const { app, token, llm } = await monter();
    for (const [nom, args] of [
      ['search-vault', { query: RECIT, exact: true }],
      ['search-cerveau', { query: `${RECIT} famille` }],
      ['ask-cerveau', { question: 'Que fait Darius le matin avec sa famille ?' }],
      ['list-files-in-vault', {}],
      ['cerveau-digest', {}],
    ] as const) {
      expect((await appel(app, token, nom, args)).corps).not.toContain(RECIT);
    }
    for (const p of llm.vus) expect(p.split('Question :')[0]).not.toContain(RECIT);
  });
});

describe('Q14 : coordonnees et numeros masques dans ce qui reste visible', () => {
  it('read-note rend le savoir, sans le courriel ni le telephone du prospect', async () => {
    const { app, token } = await monter();
    const r = await appel(app, token, 'read-note', { path: '05-projects/prospects/liste.md' });
    const contenu = r.result.structuredContent.content as string;
    expect(contenu).toContain('un site qui charge vite');
    expect(contenu).not.toContain(COURRIEL);
    expect(contenu).not.toContain(TELEPHONE);
    expect(contenu).toContain('[courriel masqué]');
  });

  it('chercher le courriel ou le numero ne les retrouve nulle part', async () => {
    const { app, token, llm } = await monter();
    for (const q of [COURRIEL, TELEPHONE, PERMIS]) {
      expect((await appel(app, token, 'search-vault', { query: q, exact: true })).corps).not.toContain(q);
      expect((await appel(app, token, 'search-cerveau', { query: q })).corps).not.toContain(q);
    }
    await appel(app, token, 'ask-cerveau', { question: 'Qui sont les prospects et comment les joindre ?' });
    for (const p of llm.vus) {
      expect(p).not.toContain(COURRIEL);
      expect(p).not.toContain(TELEPHONE);
    }
    expect(app.rag!.embeddedChunks.some(c => c.text.includes(COURRIEL))).toBe(false);
  });
});

describe('Q16 : l archive herite de la visibilite de son dossier d origine', () => {
  it('une ancienne note de projet ou de 08-auto est visible, et masquee', async () => {
    const { app, token } = await monter();
    const projet = await appel(app, token, 'read-note', { path: '09-archive/05-projects/ancien/offre.md' });
    expect(projet.result.structuredContent.content).toContain('Forfait mensuel');
    expect(projet.corps).not.toContain(COURRIEL);
    const prop = await appel(app, token, 'read-note', { path: '09-archive/08-auto/proposition.md' });
    expect(prop.result.structuredContent.content).toContain('Geler la chasse');
  });

  it.each([
    '09-archive/09-taches/vieille.md',
    '09-archive/00-personnel/papiers.md',
    '09-archive/01-raw/capture.md',
    '09-archive/Journal/2026-06-01.md',
    '09-archive/04-people/proche.md',
    '09-archive/09-archive/00-personnel/papiers.md',
  ])('%s reste cache comme son dossier d origine', async chemin => {
    const { app, token } = await monter();
    const r = await appel(app, token, 'read-note', { path: chemin });
    expect(r.result.content[0].text).toBe(messageIntrouvable(chemin));
  });

  it('rien de l archive personnelle dans le listing, la recherche ou l index', async () => {
    const { app, token } = await monter();
    const liste = await appel(app, token, 'list-files-in-vault', {});
    expect(liste.corps).toContain('09-archive/05-projects/ancien/offre.md');
    expect(liste.corps).not.toMatch(/09-archive\/(00-personnel|01-raw|Journal|04-people|09-taches)/);
    expect((await appel(app, token, 'search-cerveau', { query: RECIT })).corps).not.toContain(RECIT);
    expect(app.rag!.embeddedChunks.some(c => c.text.includes(RECIT))).toBe(false);
  });
});

describe('consigne de confidentialite', () => {
  it('les instructions de Dan demandent de respecter la vie privee de Darius', async () => {
    const { app, token } = await monter();
    const r = await request(app.app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
    expect(r.body.result.instructions).toContain('Respecte la vie privée de Darius');
  });
});
