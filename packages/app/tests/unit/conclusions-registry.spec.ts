import { describe, it, expect, beforeAll } from 'vitest';
import {
  ConclusionsRegistry,
  conclusionId,
  CONCLUSIONS_FILE,
} from '@/services/conclusions/conclusions-registry';
import type { VaultManager } from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

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
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async fileExists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
  getVaultPath(): string {
    return '/fake';
  }
}

// Count-vector embedder over a tiny vocab (same spirit as rag.spec FakeEmbedder):
// texts sharing words get high cosine, disjoint texts get 0.
const VOCAB = ['email', 'marchand', '289', 'fiche', 'laura', 'railway', 'stripe', 'abonnement'];
async function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  return texts.map(t => {
    const v = new Float32Array(VOCAB.length);
    const lower = t.toLowerCase();
    VOCAB.forEach((w, i) => {
      if (lower.includes(w)) v[i] = 1;
    });
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) {
      v[VOCAB.length - 1] = 1e-6; // avoid NaN, effectively orthogonal
      norm = 1e-6;
    }
    return v.map ? new Float32Array(v.map(x => x / norm)) : v;
  });
}

function make(embed = true): { reg: ConclusionsRegistry; vault: FakeVault } {
  const vault = new FakeVault();
  return { reg: new ConclusionsRegistry(vault, embed ? fakeEmbed : null), vault };
}

describe('conclusionId', () => {
  it('is stable across whitespace variants', () => {
    expect(conclusionId('envoyer  l email')).toBe(conclusionId('envoyer l email'));
  });
});

describe('record + persistence', () => {
  it('persists to the vault JSON and converges on re-record', async () => {
    const { reg, vault } = make();
    await reg.record({ text: 'Envoyer l email marchand 289', source: 'test', status: 'propose' });
    const data = JSON.parse(vault.files.get(CONCLUSIONS_FILE) as string);
    expect(data.items).toHaveLength(1);
    // Same text again: status update, not a new row.
    await reg.record({ text: 'Envoyer l email marchand 289', source: 'test', status: 'refuse' });
    const data2 = JSON.parse(vault.files.get(CONCLUSIONS_FILE) as string);
    expect(data2.items).toHaveLength(1);
    expect(data2.items[0].status).toBe('refuse');
  });

  it('a reformulated near-duplicate updates the same conclusion (semantic)', async () => {
    const { reg, vault } = make();
    await reg.record({ text: 'envoyer email marchand 289', source: 'a', status: 'propose' });
    await reg.record({ text: 'email 289 au marchand : envoyer', source: 'b', status: 'refuse' });
    const data = JSON.parse(vault.files.get(CONCLUSIONS_FILE) as string);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].status).toBe('refuse');
  });
});

describe('isRefused / findSimilar', () => {
  it('flags a reformulated repeat of a refusal', async () => {
    const { reg } = make();
    await reg.record({ text: 'creer la fiche laura', source: 'daily', status: 'refuse' });
    expect(await reg.isRefused('fiche laura : creer')).toBe(true);
    expect(await reg.isRefused('surveiller railway stripe')).toBe(false);
  });

  it('a validated conclusion is NOT treated as refused', async () => {
    const { reg } = make();
    await reg.record({ text: 'abonnement stripe fiche', source: 'daily', status: 'valide' });
    expect(await reg.isRefused('fiche abonnement stripe')).toBe(false);
  });

  it('works degraded (exact only) without an embedder', async () => {
    const { reg } = make(false);
    await reg.record({ text: 'creer la fiche laura', source: 'daily', status: 'refuse' });
    expect(await reg.isRefused('creer la fiche laura')).toBe(true); // exact
    expect(await reg.isRefused('fiche laura : creer')).toBe(false); // no embedder
  });
});

describe('settledMask (le juge unique du "déjà réglé")', () => {
  it('masque le validé et le promu autant que le refusé, mais pas le propose', async () => {
    const { reg } = make();
    await reg.record({ text: 'creer la fiche laura', source: 'daily', status: 'valide' });
    await reg.record({ text: 'surveiller railway', source: 'daily', status: 'promu' });
    await reg.record({ text: 'envoyer email marchand 289', source: 'daily', status: 'propose' });
    const mask = await reg.settledMask([
      'fiche laura : creer', // reformulation d'un valide
      'surveiller railway', // promu
      'envoyer email marchand 289', // seulement propose : reste visible
    ]);
    expect(mask).toEqual([true, true, false]);
  });
});

describe('refusedMask (batched)', () => {
  it('masks refused texts, exact and semantic, leaves the rest', async () => {
    const { reg } = make();
    await reg.record({ text: 'envoyer email marchand 289', source: 'x', status: 'refuse' });
    await reg.record({ text: 'surveiller railway', source: 'x', status: 'valide' });
    const mask = await reg.refusedMask([
      'email marchand 289 envoyer', // semantic repeat of a refusal
      'surveiller railway', // exists but validated, not refused
      'fiche laura toute neuve', // unknown
    ]);
    expect(mask).toEqual([true, false, false]);
  });
});
