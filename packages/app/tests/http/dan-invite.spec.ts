import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { build } from 'esbuild';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configureLogger } from '@/utils/logger';
import { createInMemoryAuthStore, setAuthStore, getAuthStore, clearRefreshGrace } from '@/services/auth';
import { creerAppDan, type AppDan } from '@/server/guest/app';
import { registerMcpRoute } from '@/server/shared/mcp-routes';
import { InviteStoreMemoire, type Invite } from '@/services/invites/invite-store';
import { messageQuota } from '@/services/invites/serveur-invite';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';

configureLogger({ stream: process.stderr, minLevel: 'error' });

/**
 * Dan, l'instance invitee, de bout en bout : les criteres d'acceptation de
 * la spec « Cerveau invite et skills integres » (2026-10-07, §8).
 */

const SECRET = 'ZORBLAX-TERME-PERSONNEL-7731';
const CLIENT_ID = 'client-dan-test';
const CLIENT_SECRET = 'secret-client-dan-test';

/** Embedder deterministe : sac de mots hache sur 64 dimensions. */
class EmbedderSacDeMots implements EmbeddingProvider {
  readonly model = 'sac-de-mots-64';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const v = new Array(64).fill(0);
      for (const mot of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        const h = crypto.createHash('md5').update(mot).digest();
        v[h[0] % 64] += 1;
      }
      v[63] += 0.01; // jamais de vecteur nul
      return v;
    });
  }
}

/**
 * LLM espion qui RECRACHE tout ce qu'on lui donne a lire : si un extrait cache
 * atteignait un prompt (ask-cerveau, graphe, synapses), il ressortirait dans la
 * reponse et le test le verrait.
 */
class LlmPerroquet implements LlmCompleter {
  readonly model = 'perroquet';
  vus: string[] = [];
  async complete(system: string, user: string): Promise<string> {
    this.vus.push(`${system}\n${user}`);
    return user;
  }
}

function coffre(): InMemoryVaultManager {
  return new InMemoryVaultManager({
    '00-personnel/finances.md': `# Finances\n\nLe loyer et ${SECRET} vivent ici.\n`,
    '04-people/laura.md': `# Laura\n\n${SECRET} est son code.\n`,
    'Personnes/Oncle.md': `# Oncle\n\nMon oncle ${SECRET}.\n`,
    '01-raw/admin/impots.md': `# Impots\n\n${SECRET}\n`,
    '05-projects/offre/playbook.md':
      '# Playbook offre\n\nUne offre vend une solution a une douleur. Le loyer du client compte.\n',
    '02-knowledge/debug.md': '# Debug\n\nPour debugger un bug python, reproduire puis isoler.\n',
    '09-skills/superpowers/systematic-debugging.md': [
      '---',
      'name: systematic-debugging',
      'catalogue_nom: superpowers-systematic-debugging',
      'collection: superpowers',
      'catalogue_description: "Use when encountering any bug, test failure, or unexpected behavior"',
      'type: document',
      '---',
      '',
      '# Systematic Debugging',
      '',
      'Find the root cause of a bug before fixing. Python, JavaScript, any language.',
    ].join('\n'),
  });
}

interface Monde {
  dan: AppDan;
  vault: InMemoryVaultManager;
  invites: InviteStoreMemoire;
  paul: Invite;
  secretPaul: string;
  llm: LlmPerroquet;
}

async function monde(options: { quotaJour?: number } = {}): Promise<Monde> {
  const vault = coffre();
  const invites = new InviteStoreMemoire();
  const { invite: paul, secret: secretPaul } = await invites.creer('Paul');
  const llm = new LlmPerroquet();
  const dan = creerAppDan({
    vault,
    invites,
    embedder: new EmbedderSacDeMots(),
    completer: llm,
    indexDir: mkdtempSync(path.join(tmpdir(), 'dan-index-')),
    persist: false,
    lecteur: (v): VaultReader => ({
      listMarkdownFiles: async () =>
        (await v.listFiles('', { recursive: true, fileTypes: ['md'] })).filter(
          f => !f.startsWith('09-skills/'),
        ),
      readFile: p => v.readFile(p),
    }),
    baseUrl: 'http://dan.test',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    quotaJour: options.quotaJour ?? 100,
  });
  await dan.demarrer();
  return { dan, vault, invites, paul, secretPaul, llm };
}

async function tokenPour(inviteId: string | undefined, token = `tok-${crypto.randomUUID()}`): Promise<string> {
  await getAuthStore().setAccessToken({
    token,
    refreshToken: `ref-${token}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    scope: 'vault:read',
    ...(inviteId ? { inviteId } : {}),
  });
  return token;
}

async function rpc(
  app: express.Express,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<request.Response> {
  const req = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ jsonrpc: '2.0', id: 1, method, params });
}

async function outil(m: Monde, token: string, name: string, args: Record<string, unknown>) {
  const res = await rpc(m.dan.app, token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body.result as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

beforeAll(() => {
  process.env.OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.OAUTH_CLIENT_SECRET = CLIENT_SECRET;
});
afterAll(() => {
  delete process.env.OAUTH_CLIENT_ID;
  delete process.env.OAUTH_CLIENT_SECRET;
});
beforeEach(() => {
  process.env.GUEST_MODE = 'true';
  process.env.CERVEAU_JETON_LOCAL = 'jeton-local-de-darius';
  process.env.PERSONAL_AUTH_TOKEN = 'secret-personnel-de-darius';
  delete process.env.CERVEAU_ZONES_SENSIBLES;
  setAuthStore(createInMemoryAuthStore());
  clearRefreshGrace();
});
afterEach(() => {
  delete process.env.GUEST_MODE;
  delete process.env.CERVEAU_JETON_LOCAL;
  delete process.env.PERSONAL_AUTH_TOKEN;
});

describe('Dan : identite et outils exposes', () => {
  it('se presente comme Dan, l IA de Darius, avec les instructions invite', async () => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    const res = await rpc(m.dan.app, t, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.body.result.serverInfo.name).toBe('Dan');
    expect(res.body.result.instructions).toContain("l'IA de Darius");
    expect(res.body.result.instructions).toContain('lecture seule');
  });

  it("n'expose que la liste blanche : ni ecriture, ni deverrouillage, ni preferences", async () => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    const res = await rpc(m.dan.app, t, 'tools/list');
    const noms = (res.body.result.tools as Array<{ name: string; description: string }>).map(x => x.name);
    for (const attendu of ['read-note', 'read-notes', 'list-files-in-vault', 'search-vault', 'search-cerveau', 'ask-cerveau', 'find-skill', 'read-skill', 'graph-cerveau', 'suggest-links', 'find-themes', 'cerveau-digest']) {
      expect(noms).toContain(attendu);
    }
    for (const interdit of ['create-note', 'edit-note', 'delete-note', 'move-note', 'append-content', 'patch-content', 'apply-diff-patch', 'create-directory', 'deverrouiller-zone-sensible', 'verrouiller-zone-sensible', 'remember-preference', 'consolidate-cerveau', 'log-journal-entry', 'put-file', 'get-file', 'add-tags', 'audit-coherence', 'find-gaps']) {
      expect(noms).not.toContain(interdit);
    }
    const desc = (res.body.result.tools as Array<{ name: string; description: string }>).find(x => x.name === 'read-note')!.description;
    expect(desc).toContain("Dan, l'IA de Darius");
  });
});

describe('Dan : critere 1, read-note', () => {
  it('chemin cache et chemin absent : meme erreur ; chemin visible : contenu', async () => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    const cache = await outil(m, t, 'read-note', { path: '00-personnel/finances.md' });
    const absent = await outil(m, t, 'read-note', { path: '00-personnel/factures.md' });
    const visible = await outil(m, t, 'read-note', { path: '05-projects/offre/playbook.md' });
    expect(cache.isError).toBe(true);
    expect(absent.isError).toBe(true);
    expect(cache.content[0].text.replace('finances', 'X')).toBe(absent.content[0].text.replace('factures', 'X'));
    expect(JSON.stringify(cache)).not.toContain(SECRET);
    expect(visible.isError).toBeFalsy();
    expect(visible.structuredContent!.content).toContain('solution a une douleur');
  });
});

describe('Dan : critere 3, anti-fuite sur tous les outils de recherche', () => {
  const appels: Array<[string, Record<string, unknown>]> = [
    ['search-vault', { query: SECRET, exact: true }],
    ['search-vault', { query: 'loyer oncle laura' }],
    ['search-cerveau', { query: SECRET }],
    ['search-cerveau', { query: 'loyer oncle laura code' }],
    ['ask-cerveau', { question: `Que sais-tu de ${SECRET} et du loyer ?` }],
    ['graph-cerveau', { question: `Qui est lie a ${SECRET} ?` }],
    ['suggest-links', {}],
    ['find-themes', { min_cluster_size: 1 }],
    ['cerveau-digest', {}],
    ['list-files-in-vault', {}],
    ['read-notes', { paths: ['04-people/laura.md', 'Personnes/Oncle.md', '01-raw/admin/impots.md'] }],
  ];

  it.each(appels)('%s ne rend rien des zones cachees', async (nom, args) => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    const r = await outil(m, t, nom, args);
    const brut = JSON.stringify(r);
    expect(brut).not.toContain(SECRET);
    expect(brut).not.toContain('masques_zone_sensible');
    if (nom === 'list-files-in-vault') {
      expect(brut).not.toMatch(/00-personnel|04-people|Personnes|01-raw\/admin/);
    }
  });

  it("aucun prompt LLM n'a jamais vu un extrait cache", async () => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    for (const [nom, args] of appels) await outil(m, t, nom, args);
    expect(m.llm.vus.length).toBeGreaterThan(0);
    for (const prompt of m.llm.vus) expect(prompt).not.toContain(SECRET);
  });
});

describe('Dan : critere 5 et securite de l auth', () => {
  it('sans token, avec le jeton local, ou avec un token perso : 401', async () => {
    const m = await monde();
    expect((await rpc(m.dan.app, null, 'tools/list')).status).toBe(401);
    expect((await rpc(m.dan.app, 'jeton-local-de-darius', 'tools/list')).status).toBe(401);
    const tokenPerso = await tokenPour(undefined);
    expect((await rpc(m.dan.app, tokenPerso, 'tools/list')).status).toBe(401);
  });

  it('PERSONAL_AUTH_TOKEN ne connecte pas a Dan ; le code de Paul, si', async () => {
    const m = await monde();
    const agent = request.agent(m.dan.app);
    await agent.get('/login');
    const refuse = await agent.post('/login').type('form').send({ token: 'secret-personnel-de-darius' });
    expect(refuse.status).toBe(200);
    expect(refuse.text).toContain('Code invalide ou révoqué');
    const ok = await agent.post('/login').type('form').send({ token: m.secretPaul });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/oauth/consent');
  });
});

describe('Dan : flux OAuth complet avec le code d un ami', () => {
  async function connecter(m: Monde): Promise<{ access: string; refresh: string }> {
    const agent = request.agent(m.dan.app);
    const verifier = 'verificateur-pkce-de-test-assez-long-pour-plain-1234567890';
    const auth = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://client.test/callback',
      code_challenge: verifier,
      code_challenge_method: 'plain',
      state: 'xyz',
    });
    expect(auth.headers.location).toBe('/login');
    await agent.post('/login').type('form').send({ token: m.secretPaul });
    const approve = await agent.post('/oauth/approve');
    const code = new URL(approve.headers.location).searchParams.get('code')!;
    const jeton = await request(m.dan.app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'http://client.test/callback',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(jeton.status).toBe(200);
    return { access: jeton.body.access_token, refresh: jeton.body.refresh_token };
  }

  it("le token obtenu ouvre Dan, et l'audit nomme Paul", async () => {
    const m = await monde();
    const { access } = await connecter(m);
    const r = await outil(m, access, 'read-note', { path: '05-projects/offre/playbook.md' });
    expect(r.isError).toBeFalsy();
    const audit = await m.invites.lireAudit();
    expect(audit[0]).toMatchObject({ nom: 'Paul', outil: 'read-note', resultat: 'ok', chemins: ['05-projects/offre/playbook.md'] });
  });

  it('critere 8 : revocation, 401 immediat sur le token ET refus du refresh', async () => {
    const m = await monde();
    const { access, refresh } = await connecter(m);
    expect((await rpc(m.dan.app, access, 'tools/list')).status).toBe(200);
    await m.invites.revoquer('Paul');
    expect((await rpc(m.dan.app, access, 'tools/list')).status).toBe(401);
    const r = await request(m.dan.app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_grant');
  });

  it('critere 9 : un token de Dan est refuse par l instance perso', async () => {
    const m = await monde();
    const { access } = await connecter(m);
    delete process.env.GUEST_MODE;
    const perso = express();
    perso.use(express.json());
    registerMcpRoute(perso, new McpServer({ name: 'perso', version: '1' }));
    expect((await rpc(perso, access, 'tools/list')).status).toBe(401);
    const tokenPerso = await tokenPour(undefined);
    expect((await rpc(perso, tokenPerso, 'tools/list')).status).toBe(200);
  });
});

describe('Dan : critere 10, quota et audit', () => {
  it('au-dela du quota, les recherches sont refusees ; les lectures passent', async () => {
    const m = await monde({ quotaJour: 2 });
    const t = await tokenPour(m.paul.id);
    expect((await outil(m, t, 'search-cerveau', { query: 'offre' })).isError).toBeFalsy();
    expect((await outil(m, t, 'find-skill', { query: 'debug' })).isError).toBeFalsy();
    const trop = await outil(m, t, 'search-cerveau', { query: 'offre' });
    expect(trop.isError).toBe(true);
    expect(trop.content[0].text).toBe(messageQuota(2));
    expect((await outil(m, t, 'read-note', { path: '02-knowledge/debug.md' })).isError).toBeFalsy();
    const audit = await m.invites.lireAudit();
    expect(audit.map(a => a.resultat)).toContain('quota');
    // L'audit ne garde jamais la requete elle-meme.
    expect(JSON.stringify(audit)).not.toContain('offre');
  });

  it("le quota d'un ami ne touche pas un autre ami", async () => {
    const m = await monde({ quotaJour: 1 });
    const { invite: marc } = await m.invites.creer('Marc');
    const tPaul = await tokenPour(m.paul.id);
    const tMarc = await tokenPour(marc.id);
    await outil(m, tPaul, 'search-cerveau', { query: 'offre' });
    expect((await outil(m, tPaul, 'search-cerveau', { query: 'offre' })).isError).toBe(true);
    expect((await outil(m, tMarc, 'search-cerveau', { query: 'offre' })).isError).toBeFalsy();
  });
});

describe('Dan : critere 4, aucun cron et aucune ecriture', () => {
  it("le bundle de Dan n'embarque aucun cron ni node-cron", async () => {
    const ici = path.dirname(fileURLToPath(import.meta.url));
    const racine = path.resolve(ici, '../..');
    const r = await build({
      entryPoints: [path.join(racine, 'src/server/local/guest-http.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      metafile: true,
      tsconfig: path.join(racine, 'tsconfig.json'),
      logLevel: 'silent',
    });
    const entrees = Object.keys(r.metafile!.inputs);
    expect(entrees.some(e => e.includes('guest/app.ts'))).toBe(true);
    expect(entrees.filter(e => /-cron\.ts$|battement|notifier|poussoir|livraison|relance/.test(e))).toEqual([]);
    const imports = Object.values(r.metafile!.outputs).flatMap(o => o.imports.map(i => i.path));
    expect(imports).not.toContain('node-cron');
  }, 30_000);

  it('aucune ecriture ne touche le coffre, quoi que demande l ami', async () => {
    const m = await monde();
    const ecritures = vi.spyOn(m.vault, 'writeFile');
    const t = await tokenPour(m.paul.id);
    await outil(m, t, 'ask-cerveau', { question: 'Comment construire une offre ?' });
    await outil(m, t, 'search-cerveau', { query: 'offre' });
    await outil(m, t, 'cerveau-digest', {});
    const pirate = await rpc(m.dan.app, t, 'tools/call', { name: 'create-note', arguments: { path: 'x.md', content: 'y' } });
    expect(JSON.stringify(pirate.body)).toMatch(/not found|introuvable|Tool create-note/i);
    expect(ecritures).not.toHaveBeenCalled();
  });
});

describe('Dan : criteres 6 et 7, skills', () => {
  it('find-skill « debug python » rend superpowers-systematic-debugging', async () => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    const r = await outil(m, t, 'find-skill', { query: 'debug python' });
    const skills = r.structuredContent!.skills as Array<{ nom: string }>;
    expect(skills.slice(0, 5).map(s => s.nom)).toContain('superpowers-systematic-debugging');
  });

  it('read-skill rend le SKILL.md complet ; un nom inconnu propose les proches', async () => {
    const m = await monde();
    const t = await tokenPour(m.paul.id);
    const r = await outil(m, t, 'read-skill', { name: 'superpowers-systematic-debugging' });
    expect(r.structuredContent!.contenu).toContain('Find the root cause of a bug before fixing');
    const inconnu = await outil(m, t, 'read-skill', { name: 'systematic-debuging' });
    expect(inconnu.isError).toBe(true);
    expect(inconnu.content[0].text).toContain('superpowers-systematic-debugging');
  });
});
