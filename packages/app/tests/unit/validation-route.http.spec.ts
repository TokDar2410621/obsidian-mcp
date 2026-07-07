import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { registerValidationRoutes } from '@/server/local/validation-route';
import type { VaultManager } from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

const TOKEN = 'testtok';

class FakeVault implements VaultManager {
  files = new Map<string, string>();
  async readFile(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error(`ENOENT: ${p}`);
    return c;
  }
  async writeFile(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async deleteFile(p: string): Promise<void> {
    this.files.delete(p);
  }
  async moveFile(): Promise<void> {}
  async createDirectory(): Promise<void> {}
  async listFiles(rel = ''): Promise<string[]> {
    const keys = [...this.files.keys()];
    if (!rel) return keys;
    const prefix = rel.replace(/\/+$/, '') + '/';
    return keys.filter(k => k === rel || k.startsWith(prefix));
  }
  async fileExists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

let server: Server;
let base: string;
const vault = new FakeVault();

beforeAll(async () => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
  process.env.CAPTURE_TOKEN = TOKEN;
  const app = express();
  const ok = registerValidationRoutes(app, vault);
  expect(ok).toBe(true);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

const task = (statut: string) =>
  `---\ntype: tache\nstatut: ${statut}\nrisque: sans-risque\ncible: vault\n---\n\n# T\n`;

describe('validation routes (HTTP)', () => {
  it('rejects a bad token with 401', async () => {
    const r = await fetch(`${base}/revue?k=wrong`);
    expect(r.status).toBe(401);
  });

  it('renders the revue page with pending tasks and proposals', async () => {
    vault.files.set('09-taches/a.md', task('a-valider'));
    vault.files.set('08-auto/_insights.md', '#\n\n## 2026-07-07\n\n- **[x] Un insight à trier**\n');
    const r = await fetch(`${base}/revue?k=${TOKEN}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Revue du cerveau');
    expect(html).toContain('/valide?k=');
    expect(html).toContain('Un insight à trier');
    expect(html).toContain('/prop?k=');
  });

  it('flips a task statut via /valide', async () => {
    vault.files.set('09-taches/b.md', task('a-valider'));
    const r = await fetch(`${base}/valide?k=${TOKEN}&t=${encodeURIComponent('09-taches/b.md')}`);
    expect(r.status).toBe(200);
    expect(vault.files.get('09-taches/b.md')).toContain('statut: validee');
  });

  it('refuses a task path outside 09-taches', async () => {
    const r = await fetch(`${base}/rejette?k=${TOKEN}&t=${encodeURIComponent('00-personnel/secret.md')}`);
    expect(r.status).toBe(400);
  });

  it('drops a proposal via /prop a=jeter', async () => {
    vault.files.set('08-auto/_insights.md', '#\n\n## 2026-07-07\n\n- **[x] Jetable**\n');
    // hash mirrors bulletHash('08-auto/_insights.md', '**[x] Jetable**')
    const { bulletHash } = await import('@/server/local/validation-route');
    const h = bulletHash('08-auto/_insights.md', '**[x] Jetable**');
    const url = `${base}/prop?k=${TOKEN}&a=jeter&f=${encodeURIComponent('08-auto/_insights.md')}&h=${h}`;
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(vault.files.get('08-auto/_insights.md')).not.toContain('Jetable');
  });
});
