import express from 'express';
import type { Express, Request, Response } from 'express';
import type { BucketStore } from '@/services/storage/bucket-store';
import { logger } from '@/utils/logger';

const MAX_BYTES = 15 * 1024 * 1024;
const READ_EXPIRY = 604800; // 7 days

function cleanKey(input: unknown): string {
  const key = String(input ?? '')
    .replace(/^\/+/, '')
    .trim();
  if (!key || key.split('/').some(seg => seg === '..' || seg === '.')) {
    throw new Error('Invalid path');
  }
  if (Buffer.byteLength(key, 'utf8') > 1024) throw new Error('Key too long');
  return key;
}

/**
 * A token-gated drag-and-drop page for pushing binaries into the bucket without
 * routing their bytes through the model. The browser POSTs the file to the
 * server (same origin, so no bucket CORS to configure) and the server uploads
 * it. Enabled only when UPLOAD_TOKEN (and a bucket) are configured.
 */
export function registerUploadRoutes(app: Express, store: BucketStore, token: string): void {
  app.get('/upload', (req: Request, res: Response) => {
    if (req.query.token !== token) {
      res.status(401).type('text/plain').send('Unauthorized — append ?token=YOUR_UPLOAD_TOKEN');
      return;
    }
    res.type('html').send(UPLOAD_HTML);
  });

  app.post(
    '/upload/file',
    express.raw({ type: '*/*', limit: MAX_BYTES }),
    async (req: Request, res: Response) => {
      if (req.query.token !== token) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      try {
        const key = cleanKey(req.query.key);
        const contentType = String(req.query.type || 'application/octet-stream');
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'Empty body' });
          return;
        }
        await store.put(key, body, contentType);
        const readUrl = await store.presignGet(key, READ_EXPIRY);
        res.json({ key, bytes: body.length, content_type: contentType, read_url: readUrl });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? 'Upload failed' });
      }
    },
  );

  logger.info('Upload page enabled at GET /upload');
}

const UPLOAD_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cerveau — déposer un fichier</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:system-ui,-apple-system,sans-serif; background:#0f1115; color:#e6e6e6; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { width:min(560px,92vw); background:#171a21; border:1px solid #262b36; border-radius:16px; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 18px; color:#8b93a7; font-size:13px; }
  label { display:block; font-size:12px; color:#8b93a7; margin:14px 0 6px; }
  input[type=text] { width:100%; box-sizing:border-box; padding:10px; border-radius:9px; border:1px solid #2b313d; background:#0f1115; color:#e6e6e6; font-size:14px; }
  #drop { margin-top:6px; border:2px dashed #2f3645; border-radius:12px; padding:28px; text-align:center; color:#8b93a7; cursor:pointer; transition:.15s; }
  #drop.hover { border-color:#5b8cff; background:#141a2b; color:#cdd6f4; }
  button { margin-top:18px; width:100%; padding:12px; border:0; border-radius:10px; background:#5b8cff; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #out { margin-top:16px; font-size:13px; word-break:break-all; }
  .ok { color:#7ee787; } .err { color:#ff7b72; }
  code { background:#0f1115; border:1px solid #2b313d; border-radius:6px; padding:2px 6px; }
  a { color:#5b8cff; }
</style>
</head>
<body>
<div class="card">
  <h1>🧠 Déposer un fichier dans le cerveau</h1>
  <p class="sub">Le fichier va dans le bucket. Tu obtiens un lien à coller dans une note.</p>
  <label for="key">Clé / chemin dans le bucket</label>
  <input id="key" type="text" placeholder="01-raw/docs/mon-fichier.pdf" />
  <div id="drop">Glisse un fichier ici, ou clique pour choisir</div>
  <input id="file" type="file" style="display:none" />
  <button id="send" disabled>Envoyer</button>
  <div id="out"></div>
</div>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const drop = document.getElementById('drop');
  const fileInput = document.getElementById('file');
  const keyInput = document.getElementById('key');
  const sendBtn = document.getElementById('send');
  const out = document.getElementById('out');
  let file = null;
  const today = new Date().toISOString().slice(0,7);

  function setFile(f){
    file = f;
    drop.textContent = f ? ('📎 ' + f.name + ' (' + Math.round(f.size/1024) + ' Ko)') : 'Glisse un fichier ici, ou clique pour choisir';
    if (f && !keyInput.value) keyInput.value = '01-raw/docs/' + today + '/' + f.name;
    sendBtn.disabled = !f;
  }
  drop.onclick = () => fileInput.click();
  fileInput.onchange = e => setFile(e.target.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('hover'); };
  drop.ondragleave = () => drop.classList.remove('hover');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hover'); setFile(e.dataTransfer.files[0]); };

  sendBtn.onclick = async () => {
    if (!file) return;
    const key = (keyInput.value || '').trim();
    if (!key) { out.innerHTML = '<span class="err">Donne une clé.</span>'; return; }
    sendBtn.disabled = true; out.textContent = 'Envoi…';
    try {
      const type = file.type || 'application/octet-stream';
      const url = '/upload/file?token=' + encodeURIComponent(token) + '&key=' + encodeURIComponent(key) + '&type=' + encodeURIComponent(type);
      const r = await fetch(url, { method:'POST', headers:{'Content-Type': type}, body: file });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const isImg = type.startsWith('image/');
      const md = (isImg ? '!' : '') + '[' + file.name + '](' + j.read_url + ')';
      out.innerHTML = '<span class="ok">✓ Envoyé (' + j.bytes + ' octets)</span><br><br>Lien : <a href="' + j.read_url + '" target="_blank">ouvrir</a><br><br>Markdown :<br><code>' + md.replace(/</g,'&lt;') + '</code>';
    } catch (e) {
      out.innerHTML = '<span class="err">✗ ' + (e.message || e) + '</span>';
    } finally {
      sendBtn.disabled = false;
    }
  };
</script>
</body>
</html>`;
