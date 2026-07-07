import { describe, it, expect, beforeAll } from 'vitest';
import {
  bulletHash,
  parsePropositions,
  findBullet,
  removeBullet,
  flipTaskStatus,
  taskFromDemand,
  listPendingTasks,
  collectPropositions,
  setTaskStatus,
  dropProposition,
  promoteProposition,
  newestDailyPath,
  parseDailyPropositions,
  collectDailyPropositions,
} from '@/server/local/validation-route';
import type { VaultManager } from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

class FakeVault implements VaultManager {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const c = this.files.get(path);
    if (c === undefined) throw new Error(`ENOENT: ${path}`);
    return c;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async moveFile(src: string, dest: string): Promise<void> {
    this.files.set(dest, await this.readFile(src));
    this.files.delete(src);
  }
  async createDirectory(): Promise<void> {}
  async listFiles(relativePath = ''): Promise<string[]> {
    const keys = [...this.files.keys()];
    if (!relativePath) return keys;
    const prefix = relativePath.replace(/\/+$/, '') + '/';
    return keys.filter(k => k === relativePath || k.startsWith(prefix));
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

const INSIGHTS = '08-auto/_insights.md';
const OBJ = '08-auto/_objectifs-propositions.md';

const INSIGHTS_MD = `---
type: note
---

# Insights

## 2026-07-07

- **[croisement] Gridar peut nourrir la page services**
  Preuve : [[a]] + [[b]]. Geste de 30 min.
- **[alerte] Le permis expire le 2026-08-31**
  Preuve : [[caq]].

## 2026-07-01

- **[business] Vieil insight à ne pas montrer**
`;

// --- pure helpers --------------------------------------------------------------

describe('bulletHash', () => {
  it('is stable and file-scoped', () => {
    expect(bulletHash(INSIGHTS, 'abc')).toBe(bulletHash(INSIGHTS, 'abc'));
    expect(bulletHash(INSIGHTS, 'abc')).not.toBe(bulletHash(OBJ, 'abc'));
    expect(bulletHash(INSIGHTS, 'abc')).not.toBe(bulletHash(INSIGHTS, 'abd'));
  });
});

describe('parsePropositions', () => {
  it('reads only the newest section, one item per bullet', () => {
    const props = parsePropositions(INSIGHTS, 'insight', INSIGHTS_MD);
    expect(props).toHaveLength(2);
    expect(props[0].text).toContain('Gridar peut nourrir');
    expect(props.some(p => p.text.includes('Vieil insight'))).toBe(false);
    // Indented "Preuve" continuation lines are not proposals.
    expect(props.some(p => p.text.startsWith('Preuve'))).toBe(false);
  });

  it('respects the max cap', () => {
    const many = ['## 2026-07-07', '', ...Array.from({ length: 20 }, (_, i) => `- item ${i}`)].join('\n');
    expect(parsePropositions(INSIGHTS, 'insight', `#\n\n${many}`, 5)).toHaveLength(5);
  });
});

describe('findBullet / removeBullet', () => {
  it('finds a bullet anywhere by hash', () => {
    const h = bulletHash(INSIGHTS, '**[alerte] Le permis expire le 2026-08-31**');
    expect(findBullet(INSIGHTS_MD, INSIGHTS, h)).toContain('permis expire');
  });

  it('removes the bullet plus its indented continuation', () => {
    const h = bulletHash(INSIGHTS, '**[croisement] Gridar peut nourrir la page services**');
    const { content, removed } = removeBullet(INSIGHTS_MD, INSIGHTS, h);
    expect(removed).toContain('Gridar');
    expect(content).not.toContain('Gridar peut nourrir');
    expect(content).not.toContain('Geste de 30 min'); // continuation gone too
    expect(content).toContain('permis expire'); // sibling untouched
  });

  it('returns null removed when the hash is unknown', () => {
    const { removed } = removeBullet(INSIGHTS_MD, INSIGHTS, 'deadbeef');
    expect(removed).toBeNull();
  });
});

describe('flipTaskStatus', () => {
  it('replaces the statut value and reports the previous one', () => {
    const md = '---\ntype: tache\nstatut: a-valider\nrisque: sans-risque\n---\n\n# T\n';
    const { content, from } = flipTaskStatus(md, 'validee');
    expect(from).toBe('a-valider');
    expect(content).toContain('statut: validee');
    expect(content).not.toContain('a-valider');
  });
});

describe('taskFromDemand', () => {
  it('builds a proposee sans-risque task with a slugged path', () => {
    const { path, content } = taskFromDemand('Donne suite a cet insight : Gridar');
    expect(path).toMatch(/^09-taches\/\d{4}-\d{2}-\d{2}-.*\.md$/);
    expect(content).toContain('statut: proposee');
    expect(content).toContain('risque: sans-risque');
    expect(content).toContain('source: cerveau');
  });
});

// --- vault operations ----------------------------------------------------------

function task(statut: string, risque = 'sans-risque', title = 'Une tâche'): string {
  return `---\ntype: tache\nstatut: ${statut}\nrisque: ${risque}\nsource: chat\ncible: vault\n---\n\n# ${title}\n\n## Demande\nx\n`;
}

describe('listPendingTasks', () => {
  it('lists a-valider and risky-proposee, skips runnable and index files', async () => {
    const v = new FakeVault();
    v.files.set('09-taches/a.md', task('a-valider'));
    v.files.set('09-taches/b.md', task('proposee', 'validation-requise'));
    v.files.set('09-taches/c.md', task('proposee', 'sans-risque')); // worker runs this alone
    v.files.set('09-taches/d.md', task('validee'));
    v.files.set('09-taches/_darius.md', '- [ ] perso');
    const pending = await listPendingTasks(v);
    const paths = pending.map(p => p.path).sort();
    expect(paths).toEqual(['09-taches/a.md', '09-taches/b.md']);
    expect(pending.find(p => p.path === '09-taches/b.md')?.statut).toBe('proposee');
  });
});

describe('setTaskStatus', () => {
  it('flips the statut and persists', async () => {
    const v = new FakeVault();
    v.files.set('09-taches/a.md', task('a-valider'));
    const { from } = await setTaskStatus(v, '09-taches/a.md', 'validee');
    expect(from).toBe('a-valider');
    expect(v.files.get('09-taches/a.md')).toContain('statut: validee');
  });
});

describe('collectPropositions', () => {
  it('gathers bullets across the 08-auto sources present', async () => {
    const v = new FakeVault();
    v.files.set(INSIGHTS, INSIGHTS_MD);
    v.files.set(OBJ, '#\n\n## 2026-07-05\n\n### Coches candidates\n- **Objectif : CAQ** : la note [[x]] (score 0.7).\n');
    const props = await collectPropositions(v);
    expect(props.length).toBe(3); // 2 insights + 1 objectif (sub-heading skipped)
    expect(props.some(p => p.label === 'objectif')).toBe(true);
    expect(props.some(p => /coches candidates/i.test(p.text))).toBe(false);
  });
});

describe('dropProposition', () => {
  it('removes the bullet and writes back', async () => {
    const v = new FakeVault();
    v.files.set(INSIGHTS, INSIGHTS_MD);
    const h = bulletHash(INSIGHTS, '**[alerte] Le permis expire le 2026-08-31**');
    const { removed } = await dropProposition(v, INSIGHTS, h);
    expect(removed).toContain('permis');
    expect(v.files.get(INSIGHTS)).not.toContain('permis expire');
  });
});

describe('promoteProposition', () => {
  it('creates a task from the bullet and drops it from the source', async () => {
    const v = new FakeVault();
    v.files.set(INSIGHTS, INSIGHTS_MD);
    const h = bulletHash(INSIGHTS, '**[croisement] Gridar peut nourrir la page services**');
    const { path, text } = await promoteProposition(v, INSIGHTS, h);
    expect(path).toMatch(/^09-taches\/.*\.md$/);
    expect(text).toContain('Gridar');
    // The new task exists and is proposee/sans-risque.
    const created = v.files.get(path as string) as string;
    expect(created).toContain('statut: proposee');
    expect(created).toContain('Donne suite a cet insight');
    // The bullet is gone from the source file.
    expect(v.files.get(INSIGHTS)).not.toContain('Gridar peut nourrir');
  });

  it('is a no-op when the hash is unknown', async () => {
    const v = new FakeVault();
    v.files.set(INSIGHTS, INSIGHTS_MD);
    const { path } = await promoteProposition(v, INSIGHTS, 'nope');
    expect(path).toBeNull();
  });
});

// --- daily notes (the orphan channel) ------------------------------------------

const DAILY = '03-daily/2026-07-06.md';
const DAILY_MD = `---
type: daily
---

# 2026-07-06

## Ingestion

Run info, rien a trier.

### ✋ Propositions en attente (à valider)

- [ ] **04-people/laura-panas.md** : créer la fiche contact Laura
- [ ] **05-projects/cerveau/** : consigner l'instabilité Railway
- [x] déjà fait, ne pas montrer

## Brief

- point de lecture, pas une proposition a trier
`;

describe('newestDailyPath', () => {
  it('picks the latest daily by date, ignores non-daily files', async () => {
    const v = new FakeVault();
    v.files.set('03-daily/2026-07-05.md', '# older');
    v.files.set(DAILY, DAILY_MD);
    v.files.set('03-daily/notes-libres.md', '# not a daily');
    expect(await newestDailyPath(v)).toBe(DAILY);
  });

  it('returns null when there is no daily', async () => {
    expect(await newestDailyPath(new FakeVault())).toBeNull();
  });
});

describe('parseDailyPropositions', () => {
  it('reads only unchecked items under the proposals section', () => {
    const props = parseDailyPropositions(DAILY, DAILY_MD);
    expect(props).toHaveLength(2);
    expect(props[0].text).toContain('laura-panas');
    expect(props.some(p => /déjà fait/.test(p.text))).toBe(false); // checked item excluded
    expect(props.some(p => /point de lecture/.test(p.text))).toBe(false); // other section excluded
    expect(props.every(p => p.label === 'daily')).toBe(true);
  });
});

describe('collectPropositions includes the daily channel', () => {
  it('merges 08-auto sources and the newest daily proposals', async () => {
    const v = new FakeVault();
    v.files.set(INSIGHTS, INSIGHTS_MD);
    v.files.set(DAILY, DAILY_MD);
    const props = await collectPropositions(v);
    expect(props.some(p => p.label === 'insight')).toBe(true);
    expect(props.filter(p => p.label === 'daily')).toHaveLength(2);
  });

  it('collectDailyPropositions is empty without a daily', async () => {
    expect(await collectDailyPropositions(new FakeVault())).toEqual([]);
  });
});

describe('daily proposition one-tap', () => {
  it('drops a daily proposition bullet', async () => {
    const v = new FakeVault();
    v.files.set(DAILY, DAILY_MD);
    const [first] = parseDailyPropositions(DAILY, DAILY_MD);
    const { removed } = await dropProposition(v, DAILY, first.hash);
    expect(removed).toContain('laura-panas');
    expect(v.files.get(DAILY)).not.toContain('créer la fiche contact Laura');
    expect(v.files.get(DAILY)).toContain("consigner l'instabilité Railway"); // sibling kept
  });

  it('promotes a daily proposition into a task and removes the bullet', async () => {
    const v = new FakeVault();
    v.files.set(DAILY, DAILY_MD);
    const [first] = parseDailyPropositions(DAILY, DAILY_MD);
    const { path, text } = await promoteProposition(v, DAILY, first.hash);
    expect(path).toMatch(/^09-taches\/.*\.md$/);
    expect(text).toContain('laura-panas');
    const created = v.files.get(path as string) as string;
    expect(created).toContain('statut: proposee');
    expect(created).toContain('carnet du jour');
    expect(v.files.get(DAILY)).not.toContain('créer la fiche contact Laura');
  });
});
