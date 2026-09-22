import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { Server } from 'node:http';
import { registerLivrableRoute } from '@/server/local/livrable-route';
import { signer } from '@/services/livraison/lien-signe';
import type { VaultManager } from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

/**
 * La route qui fait ARRIVER le livrable. Verifie ce que Darius verra : les
 * octets exacts d une image, une page qui montre, et rien d autre qui sorte.
 */

const JETON = 'jeton-http-test';
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11, 0x22, 0xff, 0xfe, 0x7f,
]);

/** Un faux coffre qui sert de VRAIS octets, et qui nomme son disque en erreur. */
class FakeVault implements VaultManager {
  bytes = new Map<string, Buffer>();
  async readFile(p: string): Promise<string> {
    const b = this.bytes.get(p);
    if (!b) throw new Error(`Failed to read file ${p}: ENOENT /srv/clone-du-serveur/${p}`);
    return b.toString('utf8');
  }
  async readBinaryFile(p: string): Promise<Buffer> {
    const b = this.bytes.get(p);
    if (!b) throw new Error(`Failed to read file ${p}: ENOENT /srv/clone-du-serveur/${p}`);
    return b;
  }
  async writeFile(p: string, c: string): Promise<void> {
    this.bytes.set(p, Buffer.from(c, 'utf8'));
  }
  async deleteFile(p: string): Promise<void> {
    this.bytes.delete(p);
  }
  async moveFile(): Promise<void> {}
  async createDirectory(): Promise<void> {}
  async listFiles(): Promise<string[]> {
    return [...this.bytes.keys()];
  }
  async fileExists(p: string): Promise<boolean> {
    return this.bytes.has(p);
  }
  getVaultPath(): string {
    return '/srv/clone-du-serveur';
  }
}

const vault = new FakeVault();
let server: Server;
let base: string;
let sauvegarde: NodeJS.ProcessEnv;

const IMAGE = '05-projects/publiar/visuel-indexation.png';
const NOTE = '02-knowledge/note-avec-script.md';
const HERO = '05-projects/tokamdarius/hero.html';

/** L URL signee d un chemin, exactement comme la notification la fabrique. */
function lien(chemin: string, vue = false): string {
  const l = signer(chemin)!;
  const q = `f=${encodeURIComponent(l.f)}&e=${l.e}&s=${l.s}`;
  return `${base}/livrable${vue ? '/vue' : ''}?${q}`;
}

/**
 * Une signature VALIDE fabriquee a la main, y compris pour un chemin que
 * `signer()` refuse. Sert a prouver que la route ne fait pas confiance a la
 * seule signature : elle revalide le chemin a chaque requete.
 */
function signatureBrute(chemin: string, e: number): string {
  const secret = crypto.createHmac('sha256', JETON).update('livrable-v1').digest();
  return crypto.createHmac('sha256', secret).update(`livrable-v1\n${chemin}\n${e}`).digest('hex');
}

beforeAll(async () => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
  sauvegarde = { ...process.env };
  process.env.CAPTURE_TOKEN = JETON;
  delete process.env.LIVRABLE_SECRET;
  delete process.env.LIVRAISON_LIEN_JOURS;

  vault.bytes.set(IMAGE, PNG);
  vault.bytes.set(NOTE, Buffer.from('# Note\n\n<script>alert(1)</script>\n', 'utf8'));
  vault.bytes.set(HERO, Buffer.from('<h1>Le hero de tokamdarius.ca</h1>', 'utf8'));
  vault.bytes.set('00-personnel/caq/imm5709-reponses-2026.md', Buffer.from('secret', 'utf8'));

  const app = express();
  expect(registerLivrableRoute(app, vault, null)).toBe(true);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  process.env = sauvegarde;
});

describe('GET /livrable : les octets', () => {
  it('23. une signature correcte sur un PNG rend 200, image/png, et les octets EXACTS', async () => {
    const r = await fetch(lien(IMAGE));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const recu = Buffer.from(await r.arrayBuffer());
    expect(recu.equals(PNG)).toBe(true);
  });

  it('24. un s falsifie rend 403 et ne laisse fuir aucun octet', async () => {
    const l = signer(IMAGE)!;
    const r = await fetch(
      `${base}/livrable?f=${encodeURIComponent(l.f)}&e=${l.e}&s=${'0'.repeat(64)}`,
    );
    expect(r.status).toBe(403);
    const corps = Buffer.from(await r.arrayBuffer());
    expect(corps.includes(PNG)).toBe(false);
  });

  it('25. un e perime rend 410 et une page lisible, sans trace d exception', async () => {
    const perime = signer(IMAGE, Date.now() - 30 * 86400 * 1000)!;
    const r = await fetch(
      `${base}/livrable?f=${encodeURIComponent(perime.f)}&e=${perime.e}&s=${perime.s}`,
    );
    expect(r.status).toBe(410);
    const html = await r.text();
    expect(html).toContain('expiré');
    expect(html).not.toContain('Error');
  });

  it('26. une zone sensible est refusee MEME avec une signature valide', async () => {
    // La signature prouve l origine, jamais le droit. La route revalide.
    const chemin = '00-personnel/caq/imm5709-reponses-2026.md';
    const e = Math.floor(Date.now() / 1000) + 86400;
    const r = await fetch(
      `${base}/livrable?f=${encodeURIComponent(chemin)}&e=${e}&s=${signatureBrute(chemin, e)}`,
    );
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('secret');
  });

  it('27. un chemin signe absent rend 404, une page francaise, sans chemin disque', async () => {
    const manquant = '05-projects/publiar/jamais-suivi-par-git.png';
    const r = await fetch(lien(manquant));
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain(manquant);
    expect(html).toContain('git');
    expect(html).not.toContain('/srv/clone-du-serveur');
    expect(html).not.toContain('ENOENT');
  });

  it('28. un .md se telecharge, un .png ne se telecharge pas', async () => {
    const md = await fetch(lien(NOTE));
    expect(md.headers.get('content-disposition')).toContain('attachment');
    const png = await fetch(lien(IMAGE));
    expect(png.headers.get('content-disposition')).toBeNull();
  });
});

describe('GET /livrable/vue : la page', () => {
  it('29. une image est rendue en <img> pointant vers les MEMES f, e, s', async () => {
    const l = signer(IMAGE)!;
    const r = await fetch(
      `${base}/livrable/vue?f=${encodeURIComponent(l.f)}&e=${l.e}&s=${l.s}`,
    );
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<img');
    expect(html).toContain('/livrable?f=');
    expect(html).toContain(encodeURIComponent(IMAGE));
    expect(html).toContain(l.s);
    expect(html).toContain(String(l.e));
  });

  it('30. un .md contenant du script est rendu ECHAPPE, comme /note', async () => {
    const html = await (await fetch(lien(NOTE, true))).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('31. un .html est enveloppe dans un iframe sandbox NU', async () => {
    const html = await (await fetch(lien(HERO, true))).text();
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox');
    expect(html).toContain('srcdoc=');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-scripts');
    // Le hero s affiche vraiment, il n est pas montre en source echappe.
    expect(html).toContain('Le hero de tokamdarius.ca');
  });

  it('32. aucune page de vue ne contient le CAPTURE_TOKEN', async () => {
    for (const url of [lien(IMAGE, true), lien(NOTE, true), lien(HERO, true)]) {
      expect(await (await fetch(url)).text()).not.toContain(JETON);
    }
  });
});

describe('sans secret de signature', () => {
  it('33. la route ne se monte pas et GET /livrable rend 404', async () => {
    const garde = { ...process.env };
    delete process.env.CAPTURE_TOKEN;
    delete process.env.LIVRABLE_SECRET;
    const app = express();
    expect(registerLivrableRoute(app, vault, null)).toBe(false);
    const srv = await new Promise<Server>(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = srv.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/livrable?f=a.png&e=1&s=x`;
    const r = await fetch(url);
    expect(r.status).toBe(404);
    srv.close();
    process.env = garde;
  });
});
