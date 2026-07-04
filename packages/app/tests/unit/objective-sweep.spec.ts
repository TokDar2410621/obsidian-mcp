import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  ObjectiveSweepService,
  parseConditions,
  parseFrontmatter,
  type SweepRag,
} from '@/services/objectives/objective-sweep';
import type { EmbeddedChunk } from '@/services/rag/types';
import type { VaultManager } from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

// --- fakes ---------------------------------------------------------------------

/** In-memory vault. Tracks writes so tests can assert convergence (no-op runs). */
class FakeVault implements VaultManager {
  files = new Map<string, string>();
  writes = 0;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes += 1;
    this.files.set(path, content);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async moveFile(src: string, dest: string): Promise<void> {
    const content = await this.readFile(src);
    this.files.delete(src);
    this.files.set(dest, content);
  }
  async createDirectory(): Promise<void> {}
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

/**
 * Deterministic 2-d embeddings: texts about insurance point at [1,0], the rest
 * at [0,1]. Cosine(match) = 1, cosine(non-match) = 0 — far from the threshold.
 */
function fakeVector(text: string): Float32Array {
  return /assurance|greenshield/i.test(text)
    ? Float32Array.from([1, 0])
    : Float32Array.from([0, 1]);
}

function chunk(file: string, text: string, tags: string[] = []): EmbeddedChunk {
  return {
    id: `${file}#0`,
    file,
    title: file,
    heading: '',
    tags,
    text,
    hash: `hash-${file}-${text.length}`,
    embedding: fakeVector(text),
  };
}

class FakeRag implements SweepRag {
  chunks: EmbeddedChunk[] = [];
  async ensureReady(): Promise<void> {}
  get embeddedChunks(): readonly EmbeddedChunk[] {
    return this.chunks;
  }
  async embedQueries(texts: string[]): Promise<Float32Array[]> {
    return texts.map(fakeVector);
  }
}

// --- fixtures ------------------------------------------------------------------

const OBJECTIVE_NOTE = `---
type: objectif
tags: [objectif, immigration]
statut: ouvert
echeance: 2999-12-31
created: 2026-07-04
updated: 2026-07-04
---

# Objectif : répondre au CAQ

## But

Envoyer les documents.

## Conditions

- [ ] **Preuve d'assurance maladie** : criteres : attestation GreenShield maladie et hospitalisation datée. Preuve :
- [x] **Formulaire signé** : criteres : formulaire signé et daté. Preuve : [[note-formulaire]] (2026-07-01)

## Annonces

## Liens
`;

function overdueObjective(echeance: string): string {
  return OBJECTIVE_NOTE.replace('echeance: 2999-12-31', `echeance: ${echeance}`);
}

// --- parsing -------------------------------------------------------------------

describe('objective parsing', () => {
  it('reads frontmatter fields case-insensitively', () => {
    const fm = parseFrontmatter(OBJECTIVE_NOTE);
    expect(fm.type).toBe('objectif');
    expect(fm.statut).toBe('ouvert');
    expect(fm.echeance).toBe('2999-12-31');
  });

  it('returns empty for a note without frontmatter', () => {
    expect(parseFrontmatter('# Juste un titre')).toEqual({});
  });

  it('extracts conditions with name, criteria and done state', () => {
    const conditions = parseConditions(OBJECTIVE_NOTE);
    expect(conditions).toHaveLength(2);
    expect(conditions[0].name).toBe("Preuve d'assurance maladie");
    expect(conditions[0].criteria).toContain('attestation GreenShield');
    expect(conditions[0].done).toBe(false);
    expect(conditions[1].done).toBe(true);
  });

  it('tolerates the accented "critères" spelling and missing Preuve label', () => {
    const conditions = parseConditions('- [ ] **X** : critères : être signé');
    expect(conditions[0].criteria).toBe('être signé');
  });
});

// --- sweep ---------------------------------------------------------------------

describe('ObjectiveSweepService', () => {
  let vault: FakeVault;
  let rag: FakeRag;
  let sweep: ObjectiveSweepService;

  beforeEach(() => {
    vault = new FakeVault();
    rag = new FakeRag();
    sweep = new ObjectiveSweepService({ rag, vault });
    vault.files.set('00-personnel/objectif-caq.md', OBJECTIVE_NOTE);
    rag.chunks = [
      chunk('00-personnel/objectif-caq.md', 'objectif caq assurance', ['objectif', 'immigration']),
    ];
  });

  it('proposes a match when a new note satisfies an unmet condition', async () => {
    rag.chunks.push(chunk('01-raw/docs/attestation.md', 'attestation assurance GreenShield reçue'));

    const result = await sweep.runSweep();

    expect(result.objectives).toBe(1);
    expect(result.proposals).toBe(1);
    const proposals = vault.files.get('08-auto/_objectifs-propositions.md')!;
    expect(proposals).toContain('01-raw/docs/attestation');
    expect(proposals).toContain("Preuve d'assurance maladie");
  });

  it('never proposes for an already-ticked condition or an unrelated note', async () => {
    rag.chunks.push(chunk('01-raw/docs/recette-gateau.md', 'recette de gâteau au chocolat'));

    const result = await sweep.runSweep();

    expect(result.proposals).toBe(0);
    expect(vault.files.has('08-auto/_objectifs-propositions.md')).toBe(false);
  });

  it('dedups: the same match is proposed once across runs', async () => {
    rag.chunks.push(chunk('01-raw/docs/attestation.md', 'attestation assurance GreenShield reçue'));

    const first = await sweep.runSweep();
    const second = await sweep.runSweep();

    expect(first.proposals).toBe(1);
    expect(second.proposals).toBe(0);
  });

  it('converges: an unchanged vault produces no writes on the second run', async () => {
    rag.chunks.push(chunk('01-raw/docs/attestation.md', 'attestation assurance GreenShield reçue'));
    await sweep.runSweep();
    const writesAfterFirst = vault.writes;

    await sweep.runSweep();

    expect(vault.writes).toBe(writesAfterFirst); // no state churn, no webhook loop
  });

  it('alerts once per day on an overdue objective and proposes en-retard', async () => {
    vault.files.set('00-personnel/objectif-caq.md', overdueObjective('2020-01-01'));

    const first = await sweep.runSweep();
    const second = await sweep.runSweep();

    expect(first.deadlineAlerts).toBe(1);
    expect(second.deadlineAlerts).toBe(0);
    const proposals = vault.files.get('08-auto/_objectifs-propositions.md')!;
    expect(proposals).toContain('DÉPASSÉE');
    expect(proposals).toContain('statut: en-retard');
  });

  it('stays silent on deadlines when every condition is ticked', async () => {
    const allDone = overdueObjective('2020-01-01').replace('- [ ]', '- [x]');
    vault.files.set('00-personnel/objectif-caq.md', allDone);

    const result = await sweep.runSweep();

    expect(result.deadlineAlerts).toBe(0);
  });

  it('pushes ONE notification when a run has news, with high priority when overdue', async () => {
    const pushed: any[] = [];
    const notify = { push: async (n: any) => void pushed.push(n) };
    sweep = new ObjectiveSweepService({ rag, vault, notify });
    vault.files.set('00-personnel/objectif-caq.md', overdueObjective('2020-01-01'));
    rag.chunks.push(chunk('01-raw/docs/attestation.md', 'attestation assurance GreenShield reçue'));

    await sweep.runSweep();

    expect(pushed).toHaveLength(1);
    expect(pushed[0].priority).toBe(4); // overdue -> high
    expect(pushed[0].message).toContain('échéance');
    expect(pushed[0].message).toContain('proposition');
  });

  it('stays silent (no push) when a run has nothing to report', async () => {
    const pushed: any[] = [];
    const notify = { push: async (n: any) => void pushed.push(n) };
    sweep = new ObjectiveSweepService({ rag, vault, notify });

    await sweep.runSweep();
    await sweep.runSweep();

    expect(pushed).toHaveLength(0);
  });

  it('ignores the objective template and 08-auto as matching sources', async () => {
    vault.files.set('_templates/objectif.md', OBJECTIVE_NOTE);
    rag.chunks.push(chunk('_templates/objectif.md', 'assurance criteres preuve', ['objectif']));
    rag.chunks.push(chunk('08-auto/_inbox-darius.md', 'assurance GreenShield mentionnée'));

    const result = await sweep.runSweep();

    expect(result.objectives).toBe(1); // template not counted as an objective
    expect(result.proposals).toBe(0); // quarantine never proposed as proof
  });
});
