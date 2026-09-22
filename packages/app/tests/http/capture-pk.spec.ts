import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { registerCaptureRoute } from '@/server/local/capture-route';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { STATUT_QUESTION, prefillQuestion, refTache } from '@/services/livraison/question';
import { configureLogger } from '@/utils/logger';

/**
 * Le dernier metre : la reponse dictee doit DEBLOQUER la tache.
 *
 * Le defaut, verifie dans le coffre et non suppose. `09-taches/_reponses.md`
 * porte aujourd'hui : « - 2026-07-12 22:21 · [reponse-libre] je n'ai pas la
 * piece d'identite de mon garant a jour (capture) ». Le champ fichier vaut
 * litteralement « capture » : la reponse n'est rattachee a aucune tache, donc
 * elle ne debloque rien et Darius a repondu dans le vide.
 */

const JETON = 'jeton-capture-test';
const TACHE = '09-taches/2026-08-31-appliquer.md';

const fiche = (statut: string): string =>
  [
    '---',
    'type: tache',
    `statut: ${statut}`,
    'risque: sans-risque',
    'source: telephone',
    'created: 2026-08-31',
    '---',
    '',
    '# Appliquer ca pour gridar et Arivex',
    '',
    '## Demande',
    'Appliquer ça pour gridar et Arivex pour chaque question planifie.',
    '',
    '## Critères de fini',
    '- [ ] La demande est satisfaite.',
    '',
  ].join('\n');

let server: Server;
let base: string;
let vault: InMemoryVaultManager;
let sauvegarde: string | undefined;

beforeAll(async () => {
  configureLogger({ stream: process.stderr, minLevel: 'error' });
  sauvegarde = process.env.CAPTURE_TOKEN;
  process.env.CAPTURE_TOKEN = JETON;
  vault = new InMemoryVaultManager({ [TACHE]: fiche(STATUT_QUESTION) });
  const app = express();
  app.use(express.json());
  expect(registerCaptureRoute(app, vault)).toBe(true);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  if (sauvegarde === undefined) delete process.env.CAPTURE_TOKEN;
  else process.env.CAPTURE_TOKEN = sauvegarde;
});

const poster = (text: string, jeton: string = JETON) =>
  fetch(`${base}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-capture-token': jeton },
    body: JSON.stringify({ text }),
  });

describe('POST /capture : une reponse pk: rattachee a sa tache', () => {
  it('ecrit le CHEMIN de la tache dans _reponses.md, plus jamais « capture »', async () => {
    const ref = refTache(TACHE);
    const r = await poster(`${prefillQuestion(ref)}la video montre un calendrier de questions`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; repris?: string };
    expect(json.ok).toBe(true);
    expect(json.repris).toBe(TACHE);

    const reponses = await vault.readFile('09-taches/_reponses.md');
    expect(reponses).toContain(`(${TACHE})`);
    expect(reponses).toContain('[reponse-a-question]');
    expect(reponses).toContain('la video montre un calendrier de questions');
    // La reference technique ne pollue pas la ligne lisible.
    expect(reponses).not.toContain(`[t:${ref}]`);
    expect(reponses).not.toContain('(capture)');
  });

  it('repasse la tache de question-posee a proposee', async () => {
    const fiche = await vault.readFile(TACHE);
    expect(fiche).toContain('statut: proposee');
    const demande = fiche.slice(fiche.indexOf('## Demande'), fiche.indexOf('## Critères'));
    expect(demande).toContain('la video montre un calendrier de questions');
  });

  it('une reponse sans reference garde le comportement d avant', async () => {
    const r = await poster('pk: je sais pas encore, je regarde ce soir');
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; repris?: string };
    expect(json.ok).toBe(true);
    expect(json.repris).toBeUndefined();
    const reponses = await vault.readFile('09-taches/_reponses.md');
    expect(reponses).toContain('[reponse-libre] je sais pas encore, je regarde ce soir (capture)');
  });

  it('une reference inconnue ne casse rien et repond 200', async () => {
    const r = await poster('pk: [t:deadbeef] une reponse orpheline');
    expect(r.status).toBe(200);
    const json = (await r.json()) as { ok: boolean; repris?: string };
    expect(json.ok).toBe(true);
    expect(json.repris).toBeUndefined();
    const reponses = await vault.readFile('09-taches/_reponses.md');
    expect(reponses).toContain('[reponse-libre] une reponse orpheline (capture)');
  });

  it('une seconde reponse sur une tache deja repartie ne la ressuscite pas', async () => {
    // La tache est en `proposee` depuis le premier test : elle n'attend plus.
    const avant = await vault.readFile(TACHE);
    const r = await poster(`${prefillQuestion(refTache(TACHE))}encore une precision`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { repris?: string };
    expect(json.repris).toBeUndefined();
    expect(await vault.readFile(TACHE)).toBe(avant);
    // La reponse est quand meme tracee, et rattachee a la bonne tache.
    const reponses = await vault.readFile('09-taches/_reponses.md');
    expect(reponses).toContain(`[reponse-libre] encore une precision (${TACHE})`);
  });

  it('reste refuse sans jeton, comportement inchange', async () => {
    const r = await poster('pk: rien du tout', 'mauvais-jeton');
    expect(r.status).toBe(401);
  });
});
