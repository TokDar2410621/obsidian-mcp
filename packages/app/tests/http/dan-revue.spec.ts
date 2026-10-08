import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import path from 'node:path';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { configureLogger } from '@/utils/logger';
import { createInMemoryAuthStore, getAuthStore, setAuthStore } from '@/services/auth';
import { creerAppDan, type AppDan } from '@/server/guest/app';
import { InviteStoreMemoire, type InviteStore } from '@/services/invites/invite-store';
import { VaultInvite, messageIntrouvable } from '@/services/invites/vault-invite';
import { redirectionAutoriseeDan } from '@/services/invites/oauth-dan';
import { registerSkillsCatalogRoute } from '@/server/local/skills-catalog-route';
import { CoffreLocal } from '@/cli/verifier-dan';
import type { EmbeddingProvider } from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';
import type { VaultManager } from '@/services/vault-manager';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';

configureLogger({ stream: process.stderr, minLevel: 'error' });

/**
 * Un test par constat de la revue adversariale du 2026-10-07. Chacun echouait
 * sur le code d'avant la revue.
 */

const JETON_GIT = 'ghp_FAUX_JETON_DE_TEST_123';
const SECRET = 'TERME-CACHE-REVUE-4410';

class Embedder implements EmbeddingProvider {
  readonly model = 'sac-de-mots-32';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const v = new Array(32).fill(0);
      for (const m of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        v[crypto.createHash('md5').update(m).digest()[0] % 32] += 1;
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
    '.git/config': `[remote "origin"]\n\turl = https://x-access-token:${JETON_GIT}@github.com/x/coffre.git\n`,
    '.git/index': '00-personnel/finances.md 04-people/laura.md',
    '.obsidian/plugins/rest/data.json': '{"apiKey":"cle-secrete"}',
    '.trash/vieux.md': `# Vieux\n\n${SECRET}\n`,
    'wa-logs.txt': `log whatsapp ${SECRET}`,
    '00-personnel/finances.md': `# Finances\n\n${SECRET}\n`,
    '05-projects/offre/playbook.md': '# Playbook\n\nUne offre vend une solution a une douleur.\n',
    'Journal/2026-07-08.md': '# Journal\n\nUne journee ordinaire.\n',
  });
}

async function dan(options: { vault?: VaultManager; invites?: InviteStore; indexDir?: string; persist?: boolean } = {}): Promise<{ app: AppDan; invites: InviteStore; llm: Perroquet }> {
  const invites = options.invites ?? new InviteStoreMemoire();
  const llm = new Perroquet();
  const app = creerAppDan({
    vault: options.vault ?? coffre(),
    invites,
    embedder: new Embedder(),
    completer: llm,
    indexDir: options.indexDir ?? mkdtempSync(path.join(tmpdir(), 'dan-revue-')),
    persist: options.persist ?? false,
    baseUrl: 'http://dan.test',
    clientId: 'client-test',
    clientSecret: 'secret-test',
    quotaJour: 100,
  });
  await app.demarrer();
  return { app, invites, llm };
}

async function appel(a: AppDan, token: string, name: string, args: Record<string, unknown>) {
  const r = await request(a.app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { status: r.status, corps: JSON.stringify(r.body), result: r.body.result };
}

async function tokenAmi(invites: InviteStore, nom = 'Paul'): Promise<string> {
  const { invite } = await invites.creer(nom);
  const token = `tok-${crypto.randomUUID()}`;
  await getAuthStore().setAccessToken({
    token,
    refreshToken: `ref-${token}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    scope: 'vault:read',
    inviteId: invite.id,
  });
  return token;
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
  delete process.env.CERVEAU_ZONES_SENSIBLES;
});

describe('constat 1 : fichiers techniques et caches', () => {
  it.each(['.git/config', '.git/index', '.obsidian/plugins/rest/data.json', '.trash/vieux.md', 'wa-logs.txt'])(
    'read-note %s : introuvable, sans rien de son contenu',
    async chemin => {
      const { app, invites } = await dan();
      const t = await tokenAmi(invites);
      const r = await appel(app, t, 'read-note', { path: chemin });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toBe(messageIntrouvable(chemin));
      expect(r.corps).not.toContain(JETON_GIT);
      expect(r.corps).not.toContain('cle-secrete');
      expect(r.corps).not.toContain(SECRET);
    },
  );

  it('ni le listing, ni l index, ni aucun prompt ne voient ces fichiers', async () => {
    const { app, invites, llm } = await dan();
    const t = await tokenAmi(invites);
    const liste = await appel(app, t, 'list-files-in-vault', {});
    expect(liste.corps).not.toMatch(/\.git|\.obsidian|\.trash|wa-logs/);
    for (const [nom, args] of [
      ['search-vault', { query: SECRET, exact: true }],
      ['search-cerveau', { query: SECRET }],
      ['ask-cerveau', { question: 'Que disent les vieux journaux et les logs whatsapp ?' }],
      ['cerveau-digest', {}],
    ] as const) {
      expect((await appel(app, t, nom, args)).corps).not.toContain(SECRET);
    }
    // Une question qui NOMME le terme le retrouve dans l'echo du perroquet :
    // ce qui compte, ce sont les extraits fournis au LLM.
    await appel(app, t, 'ask-cerveau', { question: `Que dit ${SECRET} ?` });
    expect(app.rag!.embeddedChunks.map(c => c.file)).toEqual(['05-projects/offre/playbook.md']);
    for (const p of llm.vus) expect(p.split('Question :')[0]).not.toContain(SECRET);
  });
});

describe('constat 2 et promesse 2 : indiscernabilite reelle', () => {
  it('un chemin cache et un chemin absent EN ZONE VISIBLE donnent le meme message', async () => {
    const { app, invites } = await dan();
    const t = await tokenAmi(invites);
    const cache = (await appel(app, t, 'read-note', { path: '00-personnel/finances.md' })).result.content[0].text;
    const absent = (await appel(app, t, 'read-note', { path: '05-projects/inexistant.md' })).result.content[0].text;
    expect(cache.replace('00-personnel/finances.md', 'X')).toBe(absent.replace('05-projects/inexistant.md', 'X'));
  });

  it('un refus paie la meme synchro qu un chemin absent (pas d oracle temporel)', async () => {
    const interne = coffre();
    const espion = vi.spyOn(interne, 'fileExists');
    const v = new VaultInvite(interne);
    await expect(v.readFile('00-personnel/finances.md')).rejects.toThrow('Introuvable');
    await expect(v.readFile('.git/config')).rejects.toThrow('Introuvable');
    await expect(v.listFiles('00-personnel')).rejects.toThrow('Introuvable');
    expect(espion).toHaveBeenCalledTimes(3);
  });
});

describe('constat 2 : hameconnage OAuth', () => {
  it.each([
    'https://attaquant.example/callback',
    'https://claude.ai.attaquant.example/api/mcp/auth_callback',
    'https://user:pw@claude.ai/api/mcp/auth_callback',
    'javascript:alert(1)',
  ])('refuse la redirect_uri %s, a l authorize comme au register', async uri => {
    const { app } = await dan();
    const challenge = crypto.createHash('sha256').update('v'.repeat(50)).digest('base64url');
    const r = await request(app.app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'client-test',
      redirect_uri: uri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(r.status).toBe(400);
    const reg = await request(app.app).post('/oauth/register').send({ redirect_uris: [uri] });
    expect(reg.status).toBe(400);
  });

  it('accepte le rappel claude.ai et la boucle locale de Claude Code ; refuse PKCE plain', async () => {
    expect(redirectionAutoriseeDan('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectionAutoriseeDan('http://localhost:61234/callback')).toBe(true);
    expect(redirectionAutoriseeDan('http://127.0.0.1:8080/cb')).toBe(true);
    expect(redirectionAutoriseeDan('https://localhost.attaquant.example/cb')).toBe(false);
    expect(redirectionAutoriseeDan('https://ok.example/cb', { GUEST_REDIRECT_URIS: 'https://ok.example/cb' })).toBe(true);
    const { app } = await dan();
    const r = await request(app.app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'client-test',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: 'x'.repeat(50),
      code_challenge_method: 'plain',
    });
    expect(r.status).toBe(400);
    const ok = await request(app.app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'client-test',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: crypto.createHash('sha256').update('v'.repeat(50)).digest('base64url'),
      code_challenge_method: 'S256',
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/login');
  });
});

describe('constat 3 : index perime et zones ajoutees', () => {
  it('une note deplacee en zone cachee pendant que Dan dormait disparait au boot', async () => {
    const indexDir = mkdtempSync(path.join(tmpdir(), 'dan-perime-'));
    const vault = coffre();
    await vault.writeFile('05-projects/a-deplacer.md', `# Bientot cachee\n\n${SECRET} visible pour l instant.\n`);
    const premier = await dan({ vault, indexDir, persist: true });
    expect(premier.app.rag!.embeddedChunks.some(c => c.text.includes(SECRET))).toBe(true);

    await vault.moveFile('05-projects/a-deplacer.md', '00-personnel/a-deplacer.md');
    const second = await dan({ vault, indexDir, persist: true });
    const t = await tokenAmi(second.invites);
    expect(second.app.rag!.embeddedChunks.some(c => c.text.includes(SECRET))).toBe(false);
    expect((await appel(second.app, t, 'search-cerveau', { query: SECRET })).corps).not.toContain(SECRET);
    expect((await appel(second.app, t, 'suggest-links', {})).corps).not.toContain(SECRET);
  });

  it('une zone ajoutee apres l indexation disparait aussitot du graphe et des synapses', async () => {
    const { app } = await dan();
    expect(app.rag!.embeddedChunks.some(c => c.file.startsWith('05-projects/offre/'))).toBe(true);
    process.env.CERVEAU_ZONES_SENSIBLES = '05-projects/offre/';
    expect(app.rag!.embeddedChunks.some(c => c.file.startsWith('05-projects/offre/'))).toBe(false);
  });
});

describe('constat 5 : zones d environnement mal ecrites', () => {
  it.each(['/05-projects/offre/', './05-projects/offre/', '05-projects\\offre\\', '05-PROJECTS/Offre/', ' 05-projects/offre '])('%s cache bien 05-projects/offre/', async zone => {
    const v = new VaultInvite(coffre());
    // Temoin : visible tant que la zone n'est pas posee.
    expect(await v.readFile('05-projects/offre/playbook.md')).toContain('Playbook');
    process.env.CERVEAU_ZONES_SENSIBLES = zone;
    await expect(v.readFile('05-projects/offre/playbook.md')).rejects.toThrow('Introuvable');
  });
});

describe('constat 6 : ReDoS par path_filter', () => {
  it('un motif catastrophique est traite comme du texte, sans geler Dan', async () => {
    const vault = coffre();
    await vault.writeFile(`05-projects/${'a'.repeat(60)}.md`, '# long\n\nsolution\n');
    const { app, invites } = await dan({ vault });
    const t = await tokenAmi(invites);
    const debut = Date.now();
    const r = await appel(app, t, 'search-vault', { query: 'solution', path_filter: '(.+)+\u0000' });
    expect(Date.now() - debut).toBeLessThan(2000);
    expect(r.status).toBe(200);
  });
});

describe('constat 8 : liens symboliques', () => {
  it('un lien vers une zone cachee est introuvable', async () => {
    const racine = mkdtempSync(path.join(tmpdir(), 'dan-lien-'));
    mkdirSync(path.join(racine, '00-personnel'));
    mkdirSync(path.join(racine, '02-knowledge'));
    writeFileSync(path.join(racine, '00-personnel', 'secret.md'), `# Secret\n\n${SECRET}\n`);
    writeFileSync(path.join(racine, '02-knowledge', 'vrai.md'), '# Vrai\n');
    try {
      symlinkSync(path.join(racine, '00-personnel', 'secret.md'), path.join(racine, '02-knowledge', 'lien.md'), 'file');
    } catch {
      return; // creer un lien exige des droits que Windows n'accorde pas toujours
    }
    const v = new VaultInvite(new CoffreLocal(racine));
    await expect(v.readFile('02-knowledge/lien.md')).rejects.toThrow('Introuvable');
    expect(await v.readFile('02-knowledge/vrai.md')).toBe('# Vrai\n');
    const lus = await v.readManyFiles(['02-knowledge/lien.md', '02-knowledge/vrai.md']);
    expect([...lus.keys()]).toEqual(['02-knowledge/vrai.md']);
  });
});

describe('constat 9 : route d admin', () => {
  it('refuse sans jeton AVANT d analyser le corps', async () => {
    process.env.CERVEAU_JETON_LOCAL = 'jeton-local';
    const a = express();
    const ecrit = vi.fn(async () => ({ ecrits: 0, supprimes: 0 }));
    registerSkillsCatalogRoute(a, { remplacerDossier: ecrit } as unknown as VaultManager);
    // Un JSON casse : analyse d'abord, il rendrait 400 ; refuse d'abord, 401.
    const r = await request(a)
      .post('/admin/skills-catalog')
      .set('Content-Type', 'application/json')
      .send('{"fichiers": [ casse');
    expect(r.status).toBe(401);
    // Avec le jeton, le meme corps casse est bien analyse (400).
    const avec = await request(a)
      .post('/admin/skills-catalog')
      .set('Authorization', 'Bearer jeton-local')
      .set('Content-Type', 'application/json')
      .send('{"fichiers": [ casse');
    expect(avec.status).toBe(400);
    expect(ecrit).not.toHaveBeenCalled();
    delete process.env.CERVEAU_JETON_LOCAL;
  });
});

describe('constat 10 : base indisponible', () => {
  it('le middleware repond 503 au lieu de tuer le processus', async () => {
    const invites = new InviteStoreMemoire();
    const t = await tokenAmi(invites);
    invites.parId = async () => {
      throw new Error('connexion Postgres perdue');
    };
    const { app } = await dan({ invites });
    const r = await request(app.app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${t}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(503);
  });
});

describe('aucune ecriture, toutes methodes confondues', () => {
  it('rien n atteint les methodes d ecriture du coffre', async () => {
    const vault = coffre();
    const espions = (['writeFile', 'deleteFile', 'moveFile', 'createDirectory'] as const).map(m => vi.spyOn(vault, m));
    const { app, invites } = await dan({ vault });
    const t = await tokenAmi(invites);
    for (const nom of ['create-note', 'edit-note', 'delete-note', 'move-note', 'append-content', 'patch-content', 'create-directory']) {
      await appel(app, t, nom, { path: 'x.md', content: 'y', source_path: 'a.md', destination_path: 'b.md' });
    }
    await appel(app, t, 'ask-cerveau', { question: 'offre' });
    for (const e of espions) expect(e).not.toHaveBeenCalled();
  });
});
