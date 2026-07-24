import type { Express, Request, Response } from 'express';
import type { VaultManager } from '@/services/vault-manager';
import type { ConclusionsRegistry } from '@/services/conclusions/conclusions-registry';
import { logger } from '@/utils/logger';

/**
 * One-tap validate / refuse for the cerveau's proposals. Two surfaces, one token
 * (CAPTURE_TOKEN, the same secret as /capture):
 *
 *   1. Tasks (09-taches). The chef-de-chantier worker brings a task to
 *      `statut: a-valider` and pushes a notif. Its Valider / Rejeter buttons hit
 *      `GET /valide` and `GET /rejette`, which flip the frontmatter `statut:` and
 *      let the VaultManager commit + push. A risky task waiting at `proposee`
 *      gets `GET /approuve` (proposee -> approuvee) so the worker runs it.
 *
 *   2. Proposals (08-auto). The night thinker, the objective sweep and the
 *      capture-link sweep drop bullets nobody triages. `GET /revue` renders them
 *      on one mobile page; each bullet gets "En tâche" (promote to the controlled
 *      task flow) or "Jeter" (drop the bullet). `GET /prop` performs the action.
 *
 * Every route is gated by the token in the URL (?k=TOKEN); disabled unless
 * CAPTURE_TOKEN is set. Deterministic, no LLM.
 */

const AUTO_DIR = '08-auto';
const TACHES_DIR = '09-taches';
const DAILY_DIR = '03-daily';
const TASK_PATH_RE = /^09-taches\/[A-Za-z0-9._-]+\.md$/;
const DAILY_PATH_RE = /^03-daily\/\d{4}-\d{2}-\d{2}\.md$/;

interface PropSource {
  file: string;
  label: string;
  demandPrefix: string;
}

/** The 08-auto files whose bullets are triable proposals, newest section first. */
export const PROP_SOURCES: PropSource[] = [
  {
    file: `${AUTO_DIR}/_insights.md`,
    label: 'insight',
    demandPrefix: 'Donne suite a cet insight du penseur de nuit',
  },
  {
    file: `${AUTO_DIR}/_captures-liens.md`,
    label: 'lien',
    demandPrefix: 'Donne suite a ce lien capte',
  },
  {
    file: `${AUTO_DIR}/_objectifs-propositions.md`,
    label: 'objectif',
    demandPrefix: 'Verifie et, si justifie avec preuve, applique cette coche',
  },
];
const PROP_BY_FILE = new Map(PROP_SOURCES.map(s => [s.file, s]));

// --- pure helpers (unit-tested) ------------------------------------------------

/** Small stable non-crypto hash (djb2), base36. Lets a button reference a bullet. */
export function bulletHash(file: string, text: string): string {
  let h = 5381;
  const s = `${file}|${text}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Strip a leading checkbox, wikilinks, bold, and clamp, for clean display. */
export function cleanText(text: string, max = 200): string {
  const t = text
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface Proposition {
  file: string;
  label: string;
  text: string;
  hash: string;
}

/** Bullets of the NEWEST dated `## ` section of an 08-auto file (freshest only). */
export function parsePropositions(file: string, label: string, content: string, max = 12): Proposition[] {
  const idx = content.indexOf('\n## ');
  const top = (idx >= 0 ? content.slice(idx) : content).replace(/^\n+/, '');
  const section = top.split(/\n(?=## )/)[0] ?? '';
  const items: Proposition[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const text = m[1].trim();
    if (/^coches candidates/i.test(text)) continue; // sub-heading bullet, not a proposal
    items.push({ file, label, text, hash: bulletHash(file, text) });
    if (items.length >= max) break;
  }
  return items;
}

/** Find a bullet anywhere in the file by its hash. Returns its raw text or null. */
export function findBullet(content: string, file: string, hash: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (m && bulletHash(file, m[1].trim()) === hash) return m[1].trim();
  }
  return null;
}

/** Remove the matching bullet plus its indented continuation lines. */
export function removeBullet(content: string, file: string, hash: string): { content: string; removed: string | null } {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let removed: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(lines[i]);
    if (m && removed === null && bulletHash(file, m[1].trim()) === hash) {
      removed = m[1].trim();
      let j = i + 1;
      // Swallow indented continuation lines (e.g. an insight's "Preuve:" line).
      while (j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*[-*]\s+/.test(lines[j])) j++;
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return { content: out.join('\n'), removed };
}

/** Replace the frontmatter `statut:` value; returns the previous value. */
export function flipTaskStatus(content: string, to: string): { content: string; from: string | null } {
  const m = /^statut\s*:\s*(.*)$/m.exec(content);
  const from = m ? m[1].trim() : null;
  const next = content.replace(/^(statut\s*:\s*).*$/m, `$1${to}`);
  return { content: next, from };
}

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

const day = () => new Date().toISOString().slice(0, 10);

/** A task file promoted from an 08-auto proposal, into the controlled flow. */
export function taskFromDemand(demand: string): { path: string; content: string } {
  const date = day();
  const title = demand.length > 70 ? `${demand.slice(0, 70)}...` : demand;
  const content = [
    '---',
    'type: tache',
    'statut: proposee',
    'risque: sans-risque',
    'source: cerveau',
    'cible: vault',
    `created: ${date}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Demande',
    demand,
    '',
    '## Critères de fini',
    "- [ ] La demande est satisfaite telle qu'énoncée, en s'appuyant sur les notes du cerveau.",
    "- [ ] Zéro em-dash ; rien envoyé vers l'extérieur ; aucun déploiement production.",
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

// --- vault operations (unit-tested with a fake vault) --------------------------

export interface PendingTask {
  path: string;
  title: string;
  statut: string;
  risque: string;
  /** created date (YYYY-MM-DD), for newest-first ordering. */
  date: string;
  /** one-line « ce qui a été demandé » for the collapsible summary. */
  demande: string;
  /** first meaningful lines of « ## Résultat » : the deliverable itself. */
  resultat: string;
}

/** Body of a `## Heading` section, up to the next `##` or end. */
function section(content: string, name: string): string {
  const re = new RegExp(`##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  return (re.exec(content)?.[1] ?? '').trim();
}

/** Clean a section into a short human excerpt (drop timestamps, links, bullets). */
function excerptOf(raw: string, max = 320): string {
  const line = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^\*\*\d{4}-\d{2}-\d{2}/.test(l) && !/^#{1,6}\s/.test(l) && l !== '>')
    .join(' ')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/^[-*>\s]+/, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Tasks awaiting a human: controlled ones (a-valider) and risky ones (proposee). */
export async function listPendingTasks(vault: VaultManager): Promise<PendingTask[]> {
  let files: string[] = [];
  try {
    files = await vault.listFiles(TACHES_DIR);
  } catch {
    return [];
  }
  const out: PendingTask[] = [];
  for (const f of files) {
    const rel = f.replace(/\\/g, '/');
    if (!rel.endsWith('.md')) continue;
    const base = rel.split('/').pop() as string;
    if (base.startsWith('_')) continue;
    let content = '';
    try {
      content = await vault.readFile(rel);
    } catch {
      continue;
    }
    const statut = (/^statut\s*:\s*(.*)$/m.exec(content)?.[1] ?? '').trim();
    const risque = (/^risque\s*:\s*(.*)$/m.exec(content)?.[1] ?? '').trim();
    // a-valider: done and verified, awaiting keep/drop.
    // proposee + validation-requise: risky, awaiting approval (sans-risque runs alone).
    // echouee: dead at the chef's hands, awaiting relaunch or burial (a dead
    // task must never be invisible: the resto pilot stayed silent for a day).
    const awaits =
      statut === 'a-valider' ||
      statut === 'echouee' ||
      (statut === 'proposee' && risque === 'validation-requise');
    if (!awaits) continue;
    const title = (/^#\s+(.+)$/m.exec(content)?.[1] ?? base).trim();
    const date =
      /^created\s*:\s*(\d{4}-\d{2}-\d{2})/m.exec(content)?.[1] ??
      /(\d{4}-\d{2}-\d{2})/.exec(base)?.[1] ??
      '0000-00-00';
    out.push({
      path: rel,
      title,
      statut,
      risque,
      date,
      demande: excerptOf(section(content, 'Demande'), 240),
      resultat: excerptOf(section(content, 'Résultat')),
    });
  }
  // Échouées d'abord (elles sont coincées), puis le reste du plus RÉCENT au
  // plus ancien (Darius : « les nouveaux trucs sont en bas au lieu d'en haut »).
  const rank = (t: PendingTask) => (t.statut === 'echouee' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
  return out;
}

/** The newest `03-daily/YYYY-MM-DD.md` note, or null. */
export async function newestDailyPath(vault: VaultManager): Promise<string | null> {
  let files: string[] = [];
  try {
    files = await vault.listFiles(DAILY_DIR);
  } catch {
    return null;
  }
  const dailies = files
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => DAILY_PATH_RE.test(f))
    .sort();
  return dailies.length ? dailies[dailies.length - 1] : null;
}

/**
 * Unchecked `- [ ]` items under the daily note's "Propositions en attente /
 * a valider" section. This is the orphan channel: the cloud ingestion writes
 * proposals here, and nothing used to deliver them. Now they reach /revue.
 */
export function parseDailyPropositions(dailyPath: string, content: string, max = 20): Proposition[] {
  const lines = content.split(/\r?\n/);
  const items: Proposition[] = [];
  let inSection = false;
  let sectionLevel = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      if (/propositions?.*(en attente|à valider|a valider)|à valider|a valider/i.test(title)) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
      if (inSection && level <= sectionLevel) inSection = false;
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*[-*]\s+\[ \]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const text = `[ ] ${m[1].trim()}`;
    items.push({ file: dailyPath, label: 'daily', text, hash: bulletHash(dailyPath, text) });
    if (items.length >= max) break;
  }
  return items;
}

export async function collectDailyPropositions(vault: VaultManager): Promise<Proposition[]> {
  const daily = await newestDailyPath(vault);
  if (!daily) return [];
  let content = '';
  try {
    content = await vault.readFile(daily);
  } catch {
    return [];
  }
  return parseDailyPropositions(daily, content);
}

export async function collectPropositions(vault: VaultManager): Promise<Proposition[]> {
  const all: Proposition[] = [];
  for (const src of PROP_SOURCES) {
    let content = '';
    try {
      content = await vault.readFile(src.file);
    } catch {
      continue;
    }
    all.push(...parsePropositions(src.file, src.label, content));
  }
  // The orphan channel: proposals the ingestion left in the newest daily note.
  all.push(...(await collectDailyPropositions(vault)));
  return all;
}

export async function setTaskStatus(
  vault: VaultManager,
  taskPath: string,
  to: string,
): Promise<{ from: string | null; title: string | null }> {
  const content = await vault.readFile(taskPath);
  const { content: next, from } = flipTaskStatus(content, to);
  await vault.writeFile(taskPath, next);
  const title = (/^#\s+(.+)$/m.exec(content)?.[1] ?? '').trim() || null;
  return { from, title };
}

export async function dropProposition(
  vault: VaultManager,
  file: string,
  hash: string,
): Promise<{ removed: string | null }> {
  const content = await vault.readFile(file);
  const { content: next, removed } = removeBullet(content, file, hash);
  if (removed !== null) await vault.writeFile(file, next);
  return { removed };
}

export async function promoteProposition(
  vault: VaultManager,
  file: string,
  hash: string,
): Promise<{ path: string | null; text: string | null }> {
  const src = PROP_BY_FILE.get(file);
  const demandPrefix = src ? src.demandPrefix : 'Donne suite a cette proposition du carnet du jour';
  const content = await vault.readFile(file);
  const text = findBullet(content, file, hash);
  if (text === null) return { path: null, text: null };
  const demand = `${demandPrefix} : ${cleanText(text)}`;
  const task = taskFromDemand(demand);
  if (!(await vault.fileExists(task.path))) {
    await vault.createDirectory(TACHES_DIR, true);
    await vault.writeFile(task.path, task.content);
  }
  // Promoted: drop it from the proposals file so it stops showing as pending.
  const { content: next } = removeBullet(content, file, hash);
  await vault.writeFile(file, next);
  return { path: task.path, text: cleanText(text) };
}

// --- HTML -----------------------------------------------------------------------

const CSS = `*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b0f14;color:#e6edf3;
font:16px/1.45 -apple-system,system-ui,sans-serif;padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom)}
main{max-width:600px;margin:0 auto;padding:24px 0 56px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#7d8896;margin:30px 0 10px}
p.sub{color:#9aa6b2;font-size:14px;margin:0 0 8px}
.fire{color:#fca5a5}
.legend{background:#0f1620;border:1px solid #1f2937;border-radius:12px;padding:12px 14px;margin:12px 0 4px;font-size:13.5px;color:#aeb9c5}
.legend p{margin:0 0 6px}.legend ul{margin:0;padding-left:18px}.legend li{margin:3px 0}
.legend b{color:#e6edf3}
.card{background:#131a22;border:1px solid #26313d;border-radius:14px;padding:14px;margin:12px 0}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.date{font-size:12px;color:#5f6b78;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 9px;border-radius:999px}
.pill.ok{background:#0f2e1c;color:#4ade80}.pill.warn{background:#3a2c08;color:#fbbf24}
.pill.bad{background:#3a1414;color:#f87171}.pill.idea{background:#16233a;color:#7dd3fc}
.txt{font-size:16px;font-weight:600;margin:0 0 10px;word-wrap:break-word;line-height:1.35}
details{margin:0 0 12px}
summary{cursor:pointer;color:#9aa6b2;font-size:14px;list-style:none;padding:8px 0}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸ ";color:#5f6b78}
details[open] summary::before{content:"▾ "}
.lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7684;margin:8px 0 2px}
.det{font-size:14px;color:#c7d0da;margin:0 0 6px;white-space:pre-wrap}
a.note{display:inline-block;margin:4px 0 2px;color:#7dd3fc;text-decoration:none;font-size:14px}
.row{display:flex;gap:8px;margin-top:4px}
a.btn{flex:1;text-align:center;text-decoration:none;border-radius:12px;padding:14px;font-weight:600;font-size:15px;color:#fff}
a.ok{background:#16a34a}a.ok:active{background:#15803d}
a.ko{background:#b91c1c}a.ko:active{background:#991b1b}
a.go{background:#2563eb}a.go:active{background:#1d4ed8}
.empty{color:#7d8896;text-align:center;padding:24px 0}
.note-full{display:block;white-space:pre-wrap;word-wrap:break-word;background:#0f1620;border:1px solid #1f2937;border-radius:12px;padding:16px;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c7d0da;margin:8px 0}
.back{display:inline-block;margin-top:24px;color:#3b82f6;text-decoration:none;font-size:15px}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0f14"><title>${escapeHtml(title)}</title>
<style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function confirm(title: string, sub: string, token: string): string {
  return page(
    title,
    `<div style="text-align:center;padding-top:40px">
      <p style="font-size:2.6rem;margin:0">✓</p>
      <p style="font-size:18px"><b>${escapeHtml(title)}</b></p>
      <p class="sub">${escapeHtml(sub)}</p>
      <a class="back" href="/revue?k=${encodeURIComponent(token)}">← Retour à la revue</a>
    </div>`,
  );
}

// --- routes ---------------------------------------------------------------------

export function registerValidationRoutes(
  app: Express,
  vault: VaultManager,
  registry: ConclusionsRegistry | null = null,
): boolean {
  const token = process.env.CAPTURE_TOKEN;
  if (!token) {
    logger.info('CAPTURE_TOKEN not set: validation routes disabled');
    return false;
  }

  // Metacognition: every one-tap decision feeds the conclusions registry, so
  // proposers can stop re-proposing what Darius already settled. Fire-and-log:
  // a registry failure must never break the tap itself.
  const remember = (text: string | null, source: string, status: 'valide' | 'rejete' | 'refuse' | 'promu') => {
    if (!registry || !text) return;
    registry
      .record({ text, source, status })
      .catch(error => logger.warn('Conclusions record failed', { error: String(error), source, status }));
  };

  const gate = (req: Request, res: Response): boolean => {
    if ((req.query.k as string | undefined) !== token) {
      res.status(401).type('text/plain').send('invalid token');
      return false;
    }
    return true;
  };

  const validTaskPath = (t: string): boolean => TASK_PATH_RE.test(t) && !t.includes('..');

  // Flip a task's statut. label describes the transition for the confirmation.
  const flip =
    (to: string, label: string, recordAs: 'valide' | 'rejete' | null = null) =>
    async (req: Request, res: Response) => {
      if (!gate(req, res)) return;
      const t = String(req.query.t ?? '');
      if (!validTaskPath(t)) {
        res.status(400).type('text/plain').send('bad task path');
        return;
      }
      try {
        if (!(await vault.fileExists(t))) {
          res.type('text/html').send(confirm('Introuvable', 'Cette tâche n’existe plus.', token));
          return;
        }
        const { from, title } = await setTaskStatus(vault, t, to);
        if (recordAs) remember(title, t, recordAs);
        logger.info('Task status flipped', { task: t, from, to });
        res.type('text/html').send(confirm(label, `Statut : ${from ?? '?'} → ${to}.`, token));
      } catch (error) {
        logger.error('Task flip failed', { error: String(error), task: t, to });
        res.status(500).type('text/plain').send('write failed');
      }
    };

  app.get('/valide', flip('validee', 'Validée', 'valide'));
  app.get('/rejette', flip('rejetee', 'Rejetée', 'rejete'));
  app.get('/approuve', flip('approuvee', 'Approuvée'));

  // Act on an 08-auto proposal: promote to a task, or drop it.
  app.get('/prop', async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const action = String(req.query.a ?? '');
    const file = String(req.query.f ?? '');
    const hash = String(req.query.h ?? '');
    const allowed = PROP_BY_FILE.has(file) || DAILY_PATH_RE.test(file);
    if (!allowed || !hash) {
      res.status(400).type('text/plain').send('bad proposal ref');
      return;
    }
    try {
      if (action === 'jeter') {
        const { removed } = await dropProposition(vault, file, hash);
        if (removed) remember(cleanText(removed), file, 'refuse');
        res.type('text/html').send(
          removed
            ? confirm('Jetée', 'Proposition retirée du cerveau. Elle ne reviendra pas.', token)
            : confirm('Déjà traitée', 'Cette proposition n’est plus là.', token),
        );
        return;
      }
      if (action === 'tache') {
        const { path, text } = await promoteProposition(vault, file, hash);
        if (text) remember(text, file, 'promu');
        res.type('text/html').send(
          path
            ? confirm('En tâche', `Le chef de chantier va la traiter (${path}).`, token)
            : confirm('Déjà traitée', 'Cette proposition n’est plus là.', token),
        );
        return;
      }
      res.status(400).type('text/plain').send('bad action');
    } catch (error) {
      logger.error('Proposal action failed', { error: String(error), file, action });
      res.status(500).type('text/plain').send('write failed');
    }
  });

  // Read-only full note view (« voir la note complète »). Token-gated,
  // path-validated. Rendered as escaped pre-wrap: zero injection, faithful.
  app.get('/note', async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const t = String(req.query.t ?? '');
    if (!validTaskPath(t)) {
      res.status(400).type('text/plain').send('bad note path');
      return;
    }
    try {
      const content = await vault.readFile(t);
      const title = (/^#\s+(.+)$/m.exec(content)?.[1] ?? t.split('/').pop() ?? 'Note').trim();
      const body = `<h1>${escapeHtml(title)}</h1>
        <p class="sub">${escapeHtml(t)}</p>
        <article class="note-full">${escapeHtml(content)}</article>
        <a class="back" href="/revue?k=${encodeURIComponent(token)}">← Retour à la revue</a>`;
      res.type('text/html').send(page(title, body));
    } catch (error) {
      logger.warn('Note view failed', { error: String(error), t });
      res.status(404).type('text/plain').send('note introuvable');
    }
  });

  // The triage surface: pending tasks + fresh 08-auto proposals, each one-tap.
  app.get('/revue', async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const k = encodeURIComponent(token);
    try {
      const [tasks, allProps] = await Promise.all([listPendingTasks(vault), collectPropositions(vault)]);

      // Metacognition filter: never show again what is already SETTLED
      // (refused, validated, promoted), even reformulated. One batched call.
      let props = allProps;
      let hiddenCount = 0;
      if (registry && allProps.length > 0) {
        try {
          const mask = await registry.settledMask(allProps.map(p => cleanText(p.text)));
          props = allProps.filter((_, i) => !mask[i]);
          hiddenCount = allProps.length - props.length;
        } catch (error) {
          logger.warn('Settled mask failed, showing all proposals', { error: String(error) });
        }
      }

      const nEchec = tasks.filter(t => t.statut === 'echouee').length;

      const taskCards = tasks
        .map(t => {
          const tp = encodeURIComponent(t.path);
          const kind =
            t.statut === 'a-valider'
              ? { pill: 'ok', label: 'à valider', primary: 'Valider', href: 'valide' }
              : t.statut === 'echouee'
                ? { pill: 'bad', label: 'échouée', primary: 'Relancer', href: 'approuve' }
                : { pill: 'warn', label: 'à approuver', primary: 'Approuver', href: 'approuve' };
          // Le résumé pliable : ce que le chef a produit (ou ce qui a été
          // demandé si rien n'a encore été produit). Darius décide sans partir.
          const summary = t.resultat || t.demande;
          const detail = [
            t.demande ? `<p class="lbl">Demandé</p><p class="det">${escapeHtml(t.demande)}</p>` : '',
            t.resultat ? `<p class="lbl">Produit</p><p class="det">${escapeHtml(t.resultat)}</p>` : '',
            `<a class="note" href="/note?k=${k}&t=${tp}">Ouvrir la note complète →</a>`,
          ].join('');
          return `<div class="card">
            <div class="head"><span class="pill ${kind.pill}">${kind.label}</span><span class="date">${escapeHtml(t.date)}</span></div>
            <p class="txt">${escapeHtml(t.title)}</p>
            ${summary ? `<details><summary>${escapeHtml((summary || '').slice(0, 90))}${summary.length > 90 ? '…' : ''}</summary>${detail}</details>` : `<a class="note" href="/note?k=${k}&t=${tp}">Ouvrir la note complète →</a>`}
            <div class="row"><a class="btn ${kind.pill === 'ok' ? 'ok' : 'go'}" href="/${kind.href}?k=${k}&t=${tp}">${kind.primary}</a>
            <a class="btn ko" href="/rejette?k=${k}&t=${tp}">${t.statut === 'echouee' ? 'Abandonner' : 'Rejeter'}</a></div></div>`;
        })
        .join('');

      const propCards = props
        .map(p => {
          const f = encodeURIComponent(p.file);
          const h = encodeURIComponent(p.hash);
          return `<div class="card">
            <div class="head"><span class="pill idea">${escapeHtml(p.label)}</span></div>
            <p class="txt">${escapeHtml(cleanText(p.text))}</p>
            <div class="row">
            <a class="btn go" href="/prop?k=${k}&a=tache&f=${f}&h=${h}">En faire une tâche</a>
            <a class="btn ko" href="/prop?k=${k}&a=jeter&f=${f}&h=${h}">Jeter</a></div></div>`;
        })
        .join('');

      const legende =
        `<div class="legend">
          <p><b>Comment ça marche.</b> Le cerveau a fait le travail ; toi tu tranches d'un tap.</p>
          <ul>
            <li><b>Valider</b> garde le livrable. <b>Rejeter</b> le jette.</li>
            <li><b>Approuver</b> lance une tâche risquée. <b>Relancer</b> renvoie une tâche échouée au chef.</li>
            <li><b>En faire une tâche</b> envoie une idée au chef de chantier.</li>
            <li>Touche le résumé pour le déplier, ou « Ouvrir la note complète ».</li>
          </ul>
        </div>`;

      const body =
        `<h1>Revue du cerveau</h1>` +
        `<p class="sub">${tasks.length} tâche(s) et ${props.length} idée(s) t'attendent. Les plus récentes en premier.` +
        (nEchec > 0 ? ` <b class="fire">${nEchec} échouée(s) à relancer en haut.</b>` : '') +
        `</p>` +
        legende +
        `<h2>Tâches prêtes (${tasks.length})</h2>` +
        (taskCards || '<p class="empty">Rien à valider. La file est vide.</p>') +
        `<h2>Idées à trier (${props.length})</h2>` +
        (propCards || '<p class="empty">Aucune idée fraîche.</p>') +
        (hiddenCount > 0
          ? `<p class="sub" style="margin-top:14px">${hiddenCount} idée(s) déjà réglée(s), masquée(s).</p>`
          : '');

      res.type('text/html').send(page('Revue du cerveau', body));
    } catch (error) {
      logger.error('Revue failed', { error: String(error) });
      res.status(500).type('text/plain').send('revue failed');
    }
  });

  logger.info('Validation routes registered (/valide, /rejette, /approuve, /revue, /prop, /note)');
  return true;
}
