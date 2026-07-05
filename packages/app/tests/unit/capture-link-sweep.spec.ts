import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { CaptureLinkSweepService } from '@/services/captures/capture-link-sweep';
import type { SweepRag } from '@/services/objectives/objective-sweep';
import type { EmbeddedChunk } from '@/services/rag/types';
import type { VaultManager } from '@/services/vault-manager';
import type { NotifyPusher, NotifyMessage } from '@/services/notify/notifier';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

// --- fakes ---------------------------------------------------------------------

class FakeVault implements VaultManager {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  async writeFile(path: string, content: string): Promise<void> {
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
 * Three orthogonal directions so distractors never collide: SEO -> [1,0,0],
 * QR/messaging -> [0,0,1], everything else -> [0,1,0]. Cosine(match)=1, else 0.
 */
function fakeVector(text: string): Float32Array {
  if (/seo|référencement|referencement/i.test(text)) return Float32Array.from([1, 0, 0]);
  if (/qr|messagerie|sendmenow/i.test(text)) return Float32Array.from([0, 0, 1]);
  return Float32Array.from([0, 1, 0]);
}

function chunk(file: string, text: string): EmbeddedChunk {
  return {
    id: `${file}#0`,
    file,
    title: file,
    heading: '',
    tags: [],
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

class FakeNotify implements NotifyPusher {
  pushes: NotifyMessage[] = [];
  async push(message: NotifyMessage): Promise<void> {
    this.pushes.push(message);
  }
}

// --- fixtures ------------------------------------------------------------------

const INBOX = '01-raw/inbox/2026-07-05.md';
const INBOX_CONTENT = `---
type: raw
tags: [inbox, capture]
---

# Capture 2026-07-05

- 09:12 · [Super outil SEO](https://example.com) · un outil pour optimiser le référencement
- 09:20 · une pensée sans rapport sur le café du matin
`;

function newRag(): FakeRag {
  const rag = new FakeRag();
  rag.chunks = [
    chunk(INBOX, 'un outil pour optimiser le référencement'),
    chunk('05-projects/gridar/_index.md', 'Gridar, moteur SEO et audit de référencement'),
    chunk('05-projects/sendmenow/_index.md', 'messagerie anonyme par QR code'),
  ];
  return rag;
}

// --- tests ---------------------------------------------------------------------

describe('capture link sweep', () => {
  let vault: FakeVault;
  let rag: FakeRag;
  let notify: FakeNotify;

  beforeEach(() => {
    vault = new FakeVault();
    vault.files.set(INBOX, INBOX_CONTENT);
    rag = newRag();
    notify = new FakeNotify();
  });

  it('links a matching capture to the right project and pushes one ntfy', async () => {
    const svc = new CaptureLinkSweepService({ rag, vault, notify });
    const result = await svc.runSweep();

    expect(result.newCaptures).toBe(2); // two bullets parsed
    expect(result.proposals).toBe(1); // only the SEO one matches a project
    expect(notify.pushes).toHaveLength(1);
    expect(notify.pushes[0].title).toMatch(/captures/i);

    const proposals = vault.files.get('08-auto/_captures-liens.md') ?? '';
    expect(proposals).toContain('gridar');
    expect(proposals).not.toContain('sendmenow');
  });

  it('is idempotent: a second run proposes nothing new and sends no push', async () => {
    const svc = new CaptureLinkSweepService({ rag, vault, notify });
    await svc.runSweep();
    notify.pushes = [];
    const second = await svc.runSweep();

    expect(second.newCaptures).toBe(0);
    expect(second.proposals).toBe(0);
    expect(notify.pushes).toHaveLength(0);
  });

  it('marks a non-matching capture as seen without proposing', async () => {
    // Drop the SEO project so nothing clears the threshold.
    rag.chunks = rag.chunks.filter(c => !c.file.includes('gridar'));
    const svc = new CaptureLinkSweepService({ rag, vault, notify });
    const result = await svc.runSweep();

    expect(result.proposals).toBe(0);
    expect(notify.pushes).toHaveLength(0);
    const state = JSON.parse(vault.files.get('08-auto/_captures-liens-state.json') ?? '{}');
    expect(Object.keys(state.seen ?? {}).length).toBe(2);
  });
});
