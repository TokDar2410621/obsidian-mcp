import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listPendingTasks, registerValidationRoutes } from '@/server/local/validation-route';
import { ETAT_LIVRAISON, lireEtat } from '@/services/livraison/etat';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { configureLogger } from '@/utils/logger';

/**
 * Les deux boutons de la question de peremption : « Non, archive » et
 * « Encore utile ». Un tap, une reponse, et la question ne revient pas.
 *
 * Le double de coffre est le vrai InMemoryVaultManager, pas un faux maison :
 * ces routes ecrivent l'etat de livraison via `majEtat`, et le contrat de
 * lecture-modification-ecriture doit etre exerce pour de vrai.
 */

const TOKEN = 'testtok';
const CHEMIN = '09-taches/2026-07-12-message-garant.md';

const fiche = (statut = 'a-valider') => `---
type: tache
statut: ${statut}
risque: sans-risque
source: reponses
created: 2026-07-12
---

# Rédiger le message prêt-à-envoyer au garant

## Journal

## Résultat

**2026-07-12 20:07**

resume: Message prêt à copier-coller.
livrables: 08-auto/drafts/message-garant.md
`;

let server: Server;
let base: string;
let vault: InMemoryVaultManager;

beforeAll(async () => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
  process.env.CAPTURE_TOKEN = TOKEN;
  const app = express();
  // Une seule indirection : le coffre change d'un test a l'autre, pas le serveur.
  const proxy = new Proxy({} as InMemoryVaultManager, {
    get: (_cible, prop) => {
      const valeur = (vault as unknown as Record<string | symbol, unknown>)[prop];
      return typeof valeur === 'function' ? valeur.bind(vault) : valeur;
    },
  });
  expect(registerValidationRoutes(app, proxy)).toBe(true);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vault = new InMemoryVaultManager({
    [ETAT_LIVRAISON]: JSON.stringify({ version: 1, traitees: {} }),
    [CHEMIN]: fiche(),
  });
});

describe('GET /archive', () => {
  it('refuse un mauvais jeton avec 401 et ne touche pas un octet du fichier', async () => {
    const avant = await vault.readFile(CHEMIN);
    const r = await fetch(`${base}/archive?k=mauvais&t=${encodeURIComponent(CHEMIN)}`);
    expect(r.status).toBe(401);
    expect(await vault.readFile(CHEMIN)).toBe(avant);
  });

  it('archive une tâche a-valider, puis répond « Déjà traitée » sans réécrire', async () => {
    const r = await fetch(`${base}/archive?k=${TOKEN}&t=${encodeURIComponent(CHEMIN)}`);
    expect(r.status).toBe(200);
    const apres = await vault.readFile(CHEMIN);
    expect(apres).toContain('statut: archivee');
    expect(apres).toMatch(/- \[peremption \d{4}-\d{2}-\d{2}\] Archivée sur ta réponse/);

    const rejoue = await fetch(`${base}/archive?k=${TOKEN}&t=${encodeURIComponent(CHEMIN)}`);
    expect(rejoue.status).toBe(200);
    expect(await rejoue.text()).toContain('Déjà traitée');
    expect(await vault.readFile(CHEMIN)).toBe(apres);
  });

  it('refuse un chemin non conforme avec 400 et sans aucune écriture', async () => {
    const avant = await vault.readFile(CHEMIN);
    for (const t of ['../secret.md', '00-personnel/x.md', '09-taches/', '09-taches/sous/x.md']) {
      const r = await fetch(`${base}/archive?k=${TOKEN}&t=${encodeURIComponent(t)}`);
      expect(r.status, t).toBe(400);
    }
    expect(await vault.readFile(CHEMIN)).toBe(avant);
  });

  it('rend la page « Introuvable » sur une tâche absente, jamais 500', async () => {
    const r = await fetch(`${base}/archive?k=${TOKEN}&t=09-taches/fantome.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Introuvable');
  });
});

describe('GET /encore', () => {
  it('garde le statut, écrit la marque utileLe et note le report au journal', async () => {
    const r = await fetch(`${base}/encore?k=${TOKEN}&t=${encodeURIComponent(CHEMIN)}`);
    expect(r.status).toBe(200);
    const apres = await vault.readFile(CHEMIN);
    expect(apres).toContain('statut: a-valider');
    expect(apres).toMatch(/- \[peremption \d{4}-\d{2}-\d{2}\] Encore utile/);

    const etat = await lireEtat(vault);
    const jour = new Date().toISOString().slice(0, 10);
    expect(etat.peremption?.[CHEMIN]).toEqual({ utileLe: jour });
    // La question est levee, pas reposee.
    expect(etat.peremption?.[CHEMIN]?.demandeeLe).toBeUndefined();
  });

  it('rend la page « Introuvable » sur une tâche absente et n’écrit aucun état', async () => {
    const r = await fetch(`${base}/encore?k=${TOKEN}&t=09-taches/fantome.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Introuvable');
    expect((await lireEtat(vault)).peremption).toBeUndefined();
  });

  it('refuse poliment une tâche qui n’est plus a-valider', async () => {
    await vault.writeFile(CHEMIN, fiche('validee'));
    const r = await fetch(`${base}/encore?k=${TOKEN}&t=${encodeURIComponent(CHEMIN)}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Déjà traitée');
    expect((await lireEtat(vault)).peremption).toBeUndefined();
  });
});

describe('le statut archivee sort de la file, sans toucher à la liste blanche', () => {
  it('après /archive, la tâche disparaît de listPendingTasks et de /revue', async () => {
    expect((await listPendingTasks(vault)).map(t => t.path)).toContain(CHEMIN);
    const avant = await fetch(`${base}/revue?k=${TOKEN}`);
    expect(await avant.text()).toContain('garant');

    await fetch(`${base}/archive?k=${TOKEN}&t=${encodeURIComponent(CHEMIN)}`);

    expect((await listPendingTasks(vault)).map(t => t.path)).not.toContain(CHEMIN);
    const apres = await fetch(`${base}/revue?k=${TOKEN}`);
    expect(await apres.text()).not.toContain('garant');
  });
});
