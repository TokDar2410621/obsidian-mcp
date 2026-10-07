import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { configureLogger } from '@/utils/logger';
import { SkillsService, bonusNom, nomsProches } from '@/services/skills/skills-service';
import { GitVaultReader } from '@/services/rag/vault-reader';
import { GitVaultManager } from '@/services/git-vault-manager';
import { registerSkillsCatalogRoute } from '@/server/local/skills-catalog-route';
import { cronPermis, FLAGS_CRONS, rappelMotivePermis } from '@/server/local/profil';
import { executer } from '@/cli/invites';
import { InviteStoreMemoire } from '@/services/invites/invite-store';
import type { EmbeddingProvider } from '@/services/rag/types';
import type { VaultManager } from '@/services/vault-manager';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';

configureLogger({ stream: process.stderr, minLevel: 'error' });

class Embedder implements EmbeddingProvider {
  readonly model = 'jouet';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => [/bug|debug/i.test(t) ? 1 : 0, /price|pricing|charge/i.test(t) ? 1 : 0, 0.05]);
  }
}

function catalogue(): InMemoryVaultManager {
  const fiche = (nom: string, description: string, corps: string) =>
    `---\nname: x\ncatalogue_nom: ${nom}\ncollection: ${nom.split('-')[0]}\ncatalogue_description: ${JSON.stringify(description)}\n---\n\n${corps}\n`;
  return new InMemoryVaultManager({
    '09-skills/_index.md': '# Catalogue\n',
    '09-skills/sp/LICENSE.md': '# Licence\n',
    '09-skills/sp/debugging.md': fiche('sp-debugging', 'Use when encountering any bug', '# Debugging\n\nRoot cause first.'),
    '09-skills/mk/pricing.md': fiche('mk-pricing', 'When the user asks how much to charge', '# Pricing\n\nValue metric.'),
    '09-skills/sp/debugging/references/guide.md': '# Guide\n',
    '05-projects/note.md': '# Une note\n',
  });
}

describe('SkillsService', () => {
  const service = (vault: VaultManager = catalogue()) =>
    new SkillsService({ vault, embedder: new Embedder(), indexFile: 'x.json', persist: false });

  it('charge les fiches, sans le hub ni les licences, avec leurs references', async () => {
    const s = service();
    await s.ensureReady();
    expect(s.taille).toBe(2);
    const r = await s.lire({ name: 'SP-DEBUGGING' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      nom: 'sp-debugging',
      collection: 'sp',
      references: ['09-skills/sp/debugging/references/guide.md'],
    });
    expect((r.data as { contenu: string }).contenu).toContain('Root cause first.');
  });

  it('find-skill classe par le sens et ne rend pas le contenu', async () => {
    const r = await service().trouver({ query: 'how much should I charge' });
    const skills = (r.data as { skills: Array<Record<string, unknown>> }).skills;
    expect(skills[0].nom).toBe('mk-pricing');
    expect(skills[0]).not.toHaveProperty('contenu');
  });

  it('un coffre sans catalogue rend une liste vide, sans erreur', async () => {
    const r = await service(new InMemoryVaultManager({ 'a.md': '# a' })).trouver({ query: 'bug' });
    expect(r.success).toBe(true);
    expect((r.data as { skills: unknown[] }).skills).toEqual([]);
  });

  it('read-skill inconnu propose les noms proches', async () => {
    const r = await service().lire({ name: 'debugging' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('sp-debugging');
  });
});

describe('classement', () => {
  it('bonusNom recompense un mot de la requete qui prefixe le nom', () => {
    expect(bonusNom('debug python', 'superpowers-systematic-debugging')).toBeCloseTo(0.05);
    expect(bonusNom('xx', 'superpowers-systematic-debugging')).toBe(0);
  });

  it('nomsProches remonte le nom le plus ressemblant', () => {
    expect(nomsProches('systematic-debuging', ['mk-pricing', 'superpowers-systematic-debugging', 'sp-tdd'])[0]).toBe(
      'superpowers-systematic-debugging',
    );
  });
});

describe('index general', () => {
  it('GitVaultReader exclut 09-skills (index a part)', async () => {
    const lecteur = new GitVaultReader(catalogue());
    const fichiers = await lecteur.listMarkdownFiles();
    expect(fichiers).toContain('05-projects/note.md');
    expect(fichiers.some(f => f.startsWith('09-skills/'))).toBe(false);
  });
});

describe('GitVaultManager.remplacerDossier', () => {
  it('ecrit, elague et fait UN seul commit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vault-skills-'));
    const vm = new GitVaultManager({ repoUrl: 'https://example.invalid/r.git', branch: 'main', gitToken: 'x', vaultPath: dir });
    const commits = vi.fn(async () => undefined);
    (vm as any).initialize = async () => undefined;
    (vm as any).commitAndPush = commits;

    await vm.remplacerDossier('09-skills', [
      { chemin: '09-skills/a/vieux.md', contenu: 'v' },
      { chemin: '09-skills/a/garde.md', contenu: 'g' },
    ], { message: 'm1' });
    const r = await vm.remplacerDossier('09-skills', [
      { chemin: '09-skills/a/garde.md', contenu: 'g2 — tiret' },
      { chemin: '09-skills/b/neuf.md', contenu: 'n' },
    ], { message: 'm2' });

    expect(r).toEqual({ ecrits: 2, supprimes: 1 });
    expect(commits).toHaveBeenCalledTimes(2);
    expect(commits.mock.calls[1]).toEqual(['m2', ['09-skills']]);
    expect(await readFile(path.join(dir, '09-skills/a/garde.md'), 'utf8')).toBe('g2 : tiret');
    await expect(readFile(path.join(dir, '09-skills/a/vieux.md'), 'utf8')).rejects.toThrow();
  });

  it('refuse un chemin hors du dossier', async () => {
    const vm = new GitVaultManager({ repoUrl: 'https://example.invalid/r.git', branch: 'main', gitToken: 'x', vaultPath: mkdtempSync(path.join(tmpdir(), 'v-')) });
    await expect(vm.remplacerDossier('09-skills', [{ chemin: '00-personnel/x.md', contenu: 'x' }], { message: 'm' })).rejects.toThrow(/hors du dossier/);
  });
});

describe('POST /admin/skills-catalog', () => {
  function app(): { app: express.Express; appels: unknown[][] } {
    process.env.CERVEAU_JETON_LOCAL = 'jeton-local';
    const appels: unknown[][] = [];
    const vault = {
      remplacerDossier: async (...a: unknown[]) => {
        appels.push(a);
        return { ecrits: 1, supprimes: 0 };
      },
    } as unknown as VaultManager;
    const a = express();
    registerSkillsCatalogRoute(a, vault);
    a.use(express.json());
    return { app: a, appels };
  }
  const corps = { fichiers: [{ chemin: '09-skills/sp/x.md', contenu: '# x' }] };

  it('exige le jeton local', async () => {
    const { app: a, appels } = app();
    expect((await request(a).post('/admin/skills-catalog').send(corps)).status).toBe(401);
    expect((await request(a).post('/admin/skills-catalog').set('Authorization', 'Bearer faux').send(corps)).status).toBe(401);
    expect(appels).toHaveLength(0);
    delete process.env.CERVEAU_JETON_LOCAL;
  });

  it.each([
    ['00-personnel/x.md'],
    ['09-skills/sp/x.json'],
    ['../09-skills/x.md'],
  ])('refuse %s', async chemin => {
    const { app: a, appels } = app();
    const r = await request(a)
      .post('/admin/skills-catalog')
      .set('Authorization', 'Bearer jeton-local')
      .send({ fichiers: [{ chemin, contenu: 'x' }] });
    expect(r.status).toBe(400);
    expect(appels).toHaveLength(0);
    delete process.env.CERVEAU_JETON_LOCAL;
  });

  it('accepte un catalogue de plusieurs megaoctets et ecrit en un appel', async () => {
    const { app: a, appels } = app();
    const gros = { fichiers: Array.from({ length: 300 }, (_, i) => ({ chemin: `09-skills/c/s${i}.md`, contenu: 'x'.repeat(10_000) })) };
    const r = await request(a).post('/admin/skills-catalog').set('Authorization', 'Bearer jeton-local').send(gros);
    expect(r.status).toBe(200);
    expect(appels).toHaveLength(1);
    expect((appels[0][1] as unknown[]).length).toBe(300);
    delete process.env.CERVEAU_JETON_LOCAL;
  });
});

describe('profil neutre', () => {
  it('profil de Darius : chaque cron decide seul', () => {
    for (const f of FLAGS_CRONS) expect(cronPermis(f, {})).toBe(true);
    expect(rappelMotivePermis({})).toBe(true);
  });

  it('profil neutre : tout coupe sauf un `on` explicite', () => {
    const env = { CERVEAU_PROFIL: 'neutre', DAILY_REFLECTION: 'on', STRIPE_SENSOR: 'off' };
    expect(cronPermis('DAILY_REFLECTION', env)).toBe(true);
    expect(cronPermis('STRIPE_SENSOR', env)).toBe(false);
    expect(cronPermis('MORNING_BRIEF', env)).toBe(false);
    expect(rappelMotivePermis(env)).toBe(false);
  });
});

describe('CLI invites', () => {
  it('create montre le code une fois, list, revoke, audit', async () => {
    const store = new InviteStoreMemoire();
    const lignes: string[] = [];
    const ecrire = (l: string) => lignes.push(l);
    expect(await executer(['create', 'Paul'], store, ecrire)).toBe(0);
    const code = lignes.find(l => l.trim().startsWith('dan_'))!.trim();
    expect((await store.parSecret(code))?.nom).toBe('Paul');
    expect(await executer(['create', 'paul'], store, ecrire).catch(e => String(e))).toMatch(/deja/);
    lignes.length = 0;
    await executer(['list'], store, ecrire);
    expect(lignes.join('\n')).toContain('actif');
    expect(lignes.join('\n')).not.toContain(code);
    expect(await executer(['revoke', 'Paul'], store, ecrire)).toBe(0);
    expect(await store.parSecret(code)).toBeNull();
    expect(await executer(['revoke', 'Paul'], store, ecrire)).toBe(1);
    expect(await executer(['audit', '3'], store, ecrire)).toBe(0);
  });
});
