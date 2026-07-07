import type { Express, Request, Response } from 'express';
import type { VaultManager } from '@/services/vault-manager';
import { recordAnswer } from '@/services/relance/relance-sweep';
import { logger } from '@/utils/logger';

/**
 * Frictionless capture inbox. `POST /capture` appends an idea or a URL to a
 * dated inbox note, so a phone Share button or a browser bookmarklet can drop
 * something into the cerveau without opening an agent. The VaultManager commits
 * and pushes; the webhook then reindexes and the objective sweep runs, and the
 * daily ingest agent distills, files and links the raw items later.
 *
 * Gated by CAPTURE_TOKEN (the token is the secret, so CORS is open: the
 * bookmarklet runs on arbitrary sites). Disabled unless CAPTURE_TOKEN is set.
 */

const INBOX_DIR = '01-raw/inbox';
const TACHES_DIR = '09-taches';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-capture-token',
};

const day = () => new Date().toISOString().slice(0, 10);
const hm = () => new Date().toISOString().slice(11, 16);
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * A capture starting with "fais:" is an ORDER, not a note: it becomes a task
 * file in `09-taches/` that the local chef-de-chantier worker executes and
 * verifies (see 09-taches/_HOWTO.md). Default risk is sans-risque (the worker
 * itself never sends anything external nor touches prod).
 */
function slugify(text: string, max = 50): string {
  const ascii = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return (
    ascii
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, max) || 'tache'
  );
}

function taskFile(demand: string, url: string): { path: string; content: string } {
  const date = day();
  const title = demand.length > 70 ? `${demand.slice(0, 70)}...` : demand;
  const content = [
    '---',
    'type: tache',
    'statut: proposee',
    'risque: sans-risque',
    'source: telephone',
    'cible: vault',
    `created: ${date}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Demande',
    demand + (url ? `\nLien joint : ${url}` : ''),
    '',
    '## Critères de fini',
    "- [ ] La demande est satisfaite telle qu'énoncée, en s'appuyant sur les notes du cerveau.",
    '- [ ] Zéro em-dash ; rien envoyé vers l\'extérieur ; aucun déploiement production.',
    '',
    '## Journal',
    '',
    '## Résultat',
    '',
    '## Contrôle',
    '',
  ].join('\n');
  return { path: `${TACHES_DIR}/${date}-${slugify(demand)}.md`, content };
}

function inboxHeader(date: string): string {
  return [
    '---',
    'type: raw',
    'tags: [inbox, capture]',
    `created: ${date}`,
    '---',
    '',
    `# Capture ${date}`,
    '',
    '> Captures rapides (bouton Partager / bookmarklet). Brut. L\'agent quotidien distille, range et relie.',
    '',
  ].join('\n');
}

/**
 * A dead-simple mobile capture page. Add it to the phone home screen and it
 * behaves like a tiny app: one textarea (the phone keyboard mic dictates into
 * it), one optional link field, one button that POSTs to /capture. No iOS
 * Shortcut, no bookmarklet, no variables to wire. The page is gated by the same
 * token passed once in the URL (?k=TOKEN), then baked into the page so the POST
 * carries it. Bookmark the URL-with-token; treat it like the secret it holds.
 */
function capturePage(token: string): string {
  const t = JSON.stringify(token);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Cerveau">
<meta name="theme-color" content="#0b0f14">
<title>Capture cerveau</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0b0f14; color: #e6edf3;
    font: 17px/1.4 -apple-system, system-ui, sans-serif;
    padding: env(safe-area-inset-top) 20px env(safe-area-inset-bottom); }
  main { max-width: 560px; margin: 0 auto; padding-top: 28px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #7d8896; font-size: 14px; }
  textarea, input { width: 100%; background: #131a22; color: #e6edf3;
    border: 1px solid #26313d; border-radius: 14px; padding: 16px; font: inherit; }
  textarea { min-height: 180px; resize: vertical; margin-bottom: 12px; }
  input { margin-bottom: 16px; }
  textarea:focus, input:focus { outline: none; border-color: #3b82f6; }
  button { width: 100%; border: 0; border-radius: 14px; padding: 18px;
    font: 600 18px/1 inherit; color: #fff; background: #2563eb; }
  button:active { background: #1d4ed8; }
  button:disabled { opacity: .5; }
  #s { text-align: center; margin-top: 16px; min-height: 24px; font-size: 15px; }
  .ok { color: #4ade80; } .ko { color: #f87171; }
</style>
</head>
<body>
<main>
  <h1>Capture cerveau</h1>
  <p class="sub">Ecris ou dicte (micro du clavier). Un bouton, c'est dans le cerveau.</p>
  <textarea id="t" placeholder="Ton idee..." autofocus></textarea>
  <input id="u" type="url" inputmode="url" placeholder="Lien (optionnel)">
  <button id="b">Dans le cerveau</button>
  <div id="s"></div>
</main>
<script>
  var TOKEN = ${t};
  var b = document.getElementById('b'), s = document.getElementById('s');
  var t = document.getElementById('t'), u = document.getElementById('u');
  b.onclick = function () {
    var text = t.value.trim(), url = u.value.trim();
    if (!text && !url) { s.className = 'ko'; s.textContent = 'Ecris quelque chose.'; return; }
    b.disabled = true; s.className = ''; s.textContent = 'Envoi...';
    fetch('/capture', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-capture-token': TOKEN },
      body: JSON.stringify({ text: text, url: url })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { s.className = 'ok'; s.textContent = 'Capture OK'; t.value = ''; u.value = ''; }
      else { s.className = 'ko'; s.textContent = 'Refus : ' + ((j && j.error) || 'erreur'); }
      b.disabled = false;
    }).catch(function () { s.className = 'ko'; s.textContent = 'Echec reseau'; b.disabled = false; });
  };
</script>
</body>
</html>`;
}

export function registerCaptureRoute(app: Express, vault: VaultManager): boolean {
  const token = process.env.CAPTURE_TOKEN;
  if (!token) {
    logger.info('CAPTURE_TOKEN not set — POST /capture disabled');
    return false;
  }

  // The home-screen capture app. Gated by the token in the URL (?k=TOKEN).
  app.get('/capture/app', (req: Request, res: Response) => {
    if ((req.query.k as string | undefined) !== token) {
      res.status(401).type('text/plain').send('invalid token');
      return;
    }
    res.type('text/html').send(capturePage(token));
  });

  app.options('/capture', (_req: Request, res: Response) => {
    res.set(CORS).status(204).end();
  });

  app.post('/capture', async (req: Request, res: Response) => {
    res.set(CORS);
    const provided =
      req.header('x-capture-token') ||
      (req.query.token as string | undefined) ||
      (req.body?.token as string | undefined);
    if (provided !== token) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const url = clean(req.body?.url ?? req.query.url);
    const title = clean(req.body?.title ?? req.query.title);
    const text = clean(req.body?.text ?? req.query.text);
    if (!url && !text) {
      res.status(400).json({ error: 'need url or text' });
      return;
    }

    // "todo: ..." adds a personal obligation to Darius's checklist — the daily
    // relance sweep asks "pourquoi ?" if it stalls for a day.
    const todo = /^todo\s*:\s*(.+)$/is.exec(text);
    if (todo) {
      const item = todo[1].replace(/\s+/g, ' ').trim();
      try {
        await vault.createDirectory(TACHES_DIR, true);
        const file = `${TACHES_DIR}/_darius.md`;
        const base = (await vault.fileExists(file))
          ? await vault.readFile(file)
          : [
              '---',
              'type: note',
              'tags: [taches, darius]',
              '---',
              '',
              '# Actions de Darius (surveillées par la relance)',
              '',
              '> Une case non cochée depuis 1 jour déclenche un « pourquoi ? » le soir.',
              '> Coche quand c\'est fait ; le préfixe « todo: » du téléphone ajoute ici.',
              '',
            ].join('\n');
        await vault.writeFile(file, `${base.replace(/\s*$/, '')}\n- [ ] ${item} (ajouté: ${day()})\n`);
        logger.info('Capture todo added', { file });
        res.status(200).json({ ok: true, file, todo: true });
      } catch (error) {
        logger.error('Capture todo failed', { error: String(error) });
        res.status(500).json({ error: 'write failed' });
      }
      return;
    }

    // "pk: ..." is Darius answering a relance in his own words (voice capture).
    const pk = /^pk\s*:\s*(.+)$/is.exec(text);
    if (pk) {
      try {
        await recordAnswer(vault, pk[1].replace(/\s+/g, ' ').trim(), 'capture', 'reponse-libre');
        res.status(200).json({ ok: true, file: `${TACHES_DIR}/_reponses.md`, reponse: true });
      } catch (error) {
        logger.error('Capture pk failed', { error: String(error) });
        res.status(500).json({ error: 'write failed' });
      }
      return;
    }

    // "fais: ..." turns the capture into a task for the chef-de-chantier worker.
    const order = /^fais\s*:\s*(.+)$/is.exec(text);
    if (order) {
      const demand = order[1].trim();
      const task = taskFile(demand, url);
      try {
        await vault.createDirectory(TACHES_DIR, true);
        if (await vault.fileExists(task.path)) {
          res.status(200).json({ ok: true, file: task.path, note: 'tache deja creee' });
          return;
        }
        await vault.writeFile(task.path, task.content);
        logger.info('Capture task created', { file: task.path });
        res.status(200).json({ ok: true, file: task.path, tache: true });
      } catch (error) {
        logger.error('Capture task failed', { error: String(error) });
        res.status(500).json({ error: 'write failed' });
      }
      return;
    }

    // One bullet, middot separators (never an em-dash — vault style rule).
    const parts: string[] = [];
    if (url) parts.push(title ? `[${title}](${url})` : url);
    if (text && text !== url && text !== title) parts.push(text);
    const bullet = `- ${hm()} · ${parts.join(' · ')}`;

    const file = `${INBOX_DIR}/${day()}.md`;
    try {
      await vault.createDirectory(INBOX_DIR, true);
      const base = (await vault.fileExists(file))
        ? await vault.readFile(file)
        : inboxHeader(day());
      await vault.writeFile(file, `${base.replace(/\s*$/, '')}\n${bullet}\n`);
      logger.info('Capture stored', { file });
      res.status(200).json({ ok: true, file });
    } catch (error) {
      logger.error('Capture failed', { error: String(error) });
      res.status(500).json({ error: 'write failed' });
    }
  });

  // One-tap answer to a relance (ntfy action buttons open this in the browser).
  const CAUSES: Record<string, string> = {
    manque: 'il me manque un truc',
    peur: 'pas envie ou peur',
    abandon: 'plus pertinent, abandonner',
  };
  app.get('/reponse', async (req: Request, res: Response) => {
    if ((req.query.k as string | undefined) !== token) {
      res.status(401).type('text/plain').send('invalid token');
      return;
    }
    const cause = String(req.query.c ?? '');
    const title = String(req.query.t ?? '').slice(0, 120);
    const file = String(req.query.f ?? '').slice(0, 200);
    if (!CAUSES[cause] || !title) {
      res.status(400).type('text/plain').send('missing cause or title');
      return;
    }
    try {
      await recordAnswer(vault, title, file, CAUSES[cause]);
      logger.info('Relance answered', { cause, title });
      res.type('text/html').send(
        `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<body style="font-family:system-ui;background:#0b0f14;color:#e8edf3;display:grid;place-items:center;min-height:90vh;text-align:center">` +
          `<div><p style="font-size:2.4rem;margin:0">✓</p><p><b>Noté : ${CAUSES[cause]}.</b></p>` +
          `<p style="color:#8b98aa">Le cerveau s'attaque à la cause, pas au symptôme.<br>Tu peux préciser en vocal : capture « pk: ... »</p></div>`,
      );
    } catch (error) {
      logger.error('Relance answer failed', { error: String(error) });
      res.status(500).type('text/plain').send('write failed');
    }
  });

  logger.info('Capture route registered at POST /capture (+ /reponse)');
  return true;
}
