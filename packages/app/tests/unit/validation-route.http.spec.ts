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

  it('feeds the conclusions registry and hides refused repeats (metacognition)', async () => {
    const { ConclusionsRegistry, CONCLUSIONS_FILE } = await import(
      '@/services/conclusions/conclusions-registry'
    );
    // Isolated app + vault + registry (no embedder: exact matching is enough here).
    const v2 = new FakeVault();
    const registry = new ConclusionsRegistry(v2, null);
    const app2 = express();
    registerValidationRoutes(app2, v2, registry);
    const srv2: Server = await new Promise(resolve => {
      const s = app2.listen(0, () => resolve(s));
    });
    const addr = srv2.address();
    const b2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const daily = '03-daily/2026-07-09.md';
      const bullet = '[ ] **04-people/x.md** : proposition repetitive du jour';
      v2.files.set(daily, `# j\n\n### Propositions en attente (à valider)\n\n- ${bullet}\n`);
      const { bulletHash } = await import('@/server/local/validation-route');
      const h = bulletHash(daily, bullet);
      // Darius throws it away once...
      const r = await fetch(`${b2}/prop?k=${TOKEN}&a=jeter&f=${encodeURIComponent(daily)}&h=${h}`);
      expect(r.status).toBe(200);
      // ...the refusal is registered...
      const data = JSON.parse(v2.files.get(CONCLUSIONS_FILE) as string);
      expect(data.items[0].status).toBe('refuse');
      // ...and when the ingestion re-writes the SAME proposal the next day,
      // /revue hides it instead of nagging a 30th time.
      const daily2 = '03-daily/2026-07-10.md';
      v2.files.set(daily2, `# j\n\n### Propositions en attente (à valider)\n\n- ${bullet}\n`);
      const rev = await fetch(`${b2}/revue?k=${TOKEN}`);
      const html = await rev.text();
      expect(html).not.toContain('proposition repetitive du jour');
      expect(html).toContain('déjà réglée');
    } finally {
      srv2.close();
    }
  });

  it('surfaces a daily-note proposal on /revue and can jeter it', async () => {
    const daily = '03-daily/2026-07-07.md';
    vault.files.set(
      daily,
      '# 2026-07-07\n\n### Propositions en attente (à valider)\n\n- [ ] **04-people/x.md** : orpheline du carnet\n',
    );
    const rev = await fetch(`${base}/revue?k=${TOKEN}`);
    const html = await rev.text();
    expect(html).toContain('orpheline du carnet');
    expect(html).toContain(encodeURIComponent(daily));

    const { bulletHash } = await import('@/server/local/validation-route');
    const h = bulletHash(daily, '[ ] **04-people/x.md** : orpheline du carnet');
    const r = await fetch(`${base}/prop?k=${TOKEN}&a=jeter&f=${encodeURIComponent(daily)}&h=${h}`);
    expect(r.status).toBe(200);
    expect(vault.files.get(daily)).not.toContain('orpheline du carnet');
  });

  it('a pont decision writes a labeled example (axes + label + reason) to the loop dataset', async () => {
    const { bulletHash, BOUCLE_DATASET } = await import('@/server/local/validation-route');
    const v3 = new FakeVault();
    const app3 = express();
    registerValidationRoutes(app3, v3);
    const srv3: Server = await new Promise(resolve => {
      const s = app3.listen(0, () => resolve(s));
    });
    const addr = srv3.address();
    const b3 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const ponts = '08-auto/_ponts.md';
      const t1 = '**[pont] Garder celui-ci**';
      const t2 = '**[pont] Jeter celui-la**';
      v3.files.set(
        ponts,
        `# Ponts\n\n## 2026-07-19\n\n- ${t1}\n  Axes: K=0.9 Struct=0.8 levier=0.7\n- ${t2}\n  Axes: K=0.1 Struct=0.2 levier=0.1\n`,
      );
      // Garder -> positive example (label 1, statut valide), bullet stays.
      const rGarder = await fetch(`${b3}/prop?k=${TOKEN}&a=garder&f=${encodeURIComponent(ponts)}&h=${bulletHash(ponts, t1)}`);
      expect(rGarder.status).toBe(200);
      // Jeter avec raison -> negative example (label 0, statut refuse, raison faux).
      const rJeter = await fetch(
        `${b3}/prop?k=${TOKEN}&a=jeter&r=faux&f=${encodeURIComponent(ponts)}&h=${bulletHash(ponts, t2)}`,
      );
      expect(rJeter.status).toBe(200);

      const lines = (v3.files.get(BOUCLE_DATASET) as string)
        .trim()
        .split('\n')
        .map(l => JSON.parse(l));
      expect(lines).toHaveLength(2);
      const kept = lines.find(l => l.statut === 'valide');
      expect(kept).toMatchObject({ label: 1, origine: 'pont', axes: { K: 0.9, Struct: 0.8, levier: 0.7 } });
      const dropped = lines.find(l => l.statut === 'refuse');
      expect(dropped).toMatchObject({ label: 0, raison: 'faux', axes: { K: 0.1, Struct: 0.2, levier: 0.1 } });
    } finally {
      srv3.close();
    }
  });

  it('an insight decision (no axes) writes NO loop example', async () => {
    const { bulletHash, BOUCLE_DATASET } = await import('@/server/local/validation-route');
    const v4 = new FakeVault();
    const app4 = express();
    registerValidationRoutes(app4, v4);
    const srv4: Server = await new Promise(resolve => {
      const s = app4.listen(0, () => resolve(s));
    });
    const addr = srv4.address();
    const b4 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const ins = '08-auto/_insights.md';
      const t = '**[contradiction] Un insight sans axes**';
      v4.files.set(ins, `# Insights\n\n## 2026-07-19\n\n- ${t}\n  Preuve : [[a]] + [[b]].\n`);
      const r = await fetch(`${b4}/prop?k=${TOKEN}&a=jeter&f=${encodeURIComponent(ins)}&h=${bulletHash(ins, t)}`);
      expect(r.status).toBe(200);
      expect(v4.files.has(BOUCLE_DATASET)).toBe(false);
    } finally {
      srv4.close();
    }
  });
});
