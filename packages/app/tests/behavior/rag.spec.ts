import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { RagService } from '@/services/rag/rag-service';
import { chunkNote, parseNote, toWikilink } from '@/services/rag/chunker';
import { verifyGithubSignature } from '@/server/local/github-webhook';
import type {
  AnswerGenerator,
  EmbeddingProvider,
  GenContext,
  GenResult,
  VaultReader,
} from '@/services/rag/types';

// Deterministic toy embedder: each text becomes a count vector over a small
// vocabulary, so cosine ranking is predictable without a real model.
const VOCAB = ['stripe', 'redis', 'django', 'rag', 'vault'];

function toVector(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map(word => (lower.match(new RegExp(word, 'g')) ?? []).length);
}

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake-embedder';
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map(toVector);
  }
}

class FakeGenerator implements AnswerGenerator {
  readonly model = 'fake-generator';
  lastContexts: GenContext[] = [];
  async generate(question: string, contexts: GenContext[]): Promise<GenResult> {
    this.lastContexts = contexts;
    // Comme le vrai modèle conforme : chaque source citée en wikilink Obsidian
    // (le contrôle d'ancrage rejette toute réponse sans citation).
    return {
      answer: `À propos de "${question}": ${contexts.map(c => `[[${c.wikilink}]]`).join(', ')}`,
      refused: false,
    };
  }
}

function makeReader(vault: InMemoryVaultManager): VaultReader {
  return {
    async listMarkdownFiles() {
      const files = await vault.listFiles('', { recursive: true, fileTypes: ['md'] });
      return files.filter(f => !f.startsWith('_templates/'));
    },
    readFile: p => vault.readFile(p),
  };
}

const VAULT = () =>
  new InMemoryVaultManager({
    '02-knowledge/stripe/stripe-webhooks.md':
      '---\ntags: [stripe]\n---\n# Stripe\n\nStripe webhooks and Stripe Connect.',
    '02-knowledge/redis/redis-pattern.md':
      '---\ntags: [redis]\n---\n# Redis\n\nRedis dual database pattern with Redis channels.',
    '_templates/daily.md': '# Template\n\nstripe redis placeholder',
  });

describe('RAG — chunker', () => {
  it('parses frontmatter title and tags', () => {
    const note = '---\ntitle: My Note\ntags: [a, b]\n---\n# H1\n\nintro\n\n## Section\n\nbody';
    const parsed = parseNote(note);
    expect(parsed.title).toBe('My Note');
    expect(parsed.tags).toEqual(['a', 'b']);
  });

  it('splits a note into heading-aware chunks with sha256 hashes', () => {
    const note =
      '---\ntitle: My Note\ntags: [a]\n---\n# Intro\n\nintro text\n\n## Section\n\nsection body';
    const chunks = chunkNote('folder/My Note.md', note);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every(c => c.hash.length === 64)).toBe(true);
    expect(chunks.every(c => c.title === 'My Note')).toBe(true);
  });

  it('derives wikilinks from the filename', () => {
    expect(toWikilink('a/b/redis-pattern.md')).toBe('redis-pattern');
  });
});

describe('RAG — search-cerveau', () => {
  it('ranks by semantic similarity and excludes _templates', async () => {
    const rag = new RagService({
      reader: makeReader(VAULT()),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile: '/unused',
      persist: false,
    });

    const res = await rag.searchCerveau({ query: 'redis pattern' });
    expect(res.success).toBe(true);
    expect(res.data.results[0].path).toBe('02-knowledge/redis/redis-pattern.md');
    expect(res.data.results.find((r: any) => r.path.startsWith('_templates/'))).toBeUndefined();
  });

  it('honours the folder filter', async () => {
    const rag = new RagService({
      reader: makeReader(VAULT()),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile: '/unused',
      persist: false,
    });

    const res = await rag.searchCerveau({ query: 'stripe redis', folder: '02-knowledge/stripe/' });
    expect(res.success).toBe(true);
    expect(res.data.results.every((r: any) => r.path.startsWith('02-knowledge/stripe/'))).toBe(
      true,
    );
  });
});

describe('RAG — ask-cerveau', () => {
  it('retrieves context and returns a cited answer', async () => {
    const generator = new FakeGenerator();
    const rag = new RagService({
      reader: makeReader(VAULT()),
      embedder: new FakeEmbedder(),
      generator,
      indexFile: '/unused',
      persist: false,
    });

    const res = await rag.askCerveau({ question: 'parle moi de redis' });
    expect(res.success).toBe(true);
    expect(generator.lastContexts.length).toBeGreaterThan(0);
    expect(res.data.citations[0].wikilink).toBe('redis-pattern');
    expect(res.data.used_chunks).toBe(res.data.citations.length);
  });

  it('remplace par le refus une réponse qui ne cite aucune note (savoir général déguisé)', async () => {
    const generator: AnswerGenerator = {
      model: 'bavard-sans-sources',
      async generate() {
        return { answer: 'Redis est une base clé-valeur inventée en 2009.', refused: false };
      },
    };
    const rag = new RagService({
      reader: makeReader(VAULT()),
      embedder: new FakeEmbedder(),
      generator,
      indexFile: '/unused',
      persist: false,
    });

    const res = await rag.askCerveau({ question: 'parle moi de redis' });
    expect(res.success).toBe(true);
    expect(res.data.answer).toContain('Je ne trouve pas ça dans le cerveau');
    expect(res.data.citations).toEqual([]);
  });

  it('fails clearly when no generator is configured', async () => {
    const rag = new RagService({
      reader: makeReader(VAULT()),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile: '/unused',
      persist: false,
    });

    const res = await rag.askCerveau({ question: 'anything' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('ANTHROPIC_API_KEY');
  });
});

describe('RAG — incremental indexing', () => {
  it('re-embeds nothing when the vault is unchanged', async () => {
    const embedder = new FakeEmbedder();
    const rag = new RagService({
      reader: makeReader(VAULT()),
      embedder,
      generator: null,
      indexFile: '/unused',
      persist: false,
    });

    await rag.refresh();
    const callsAfterFirst = embedder.calls;
    const second = await rag.refresh();

    expect(second.embedded).toBe(0);
    expect(embedder.calls).toBe(callsAfterFirst);
  });
});

describe('RAG — persistence round-trip', () => {
  const indexDir = path.join(os.tmpdir(), 'cerveau-rag-persist-test');
  const indexFile = path.join(indexDir, 'cerveau-index.json');

  afterAll(async () => {
    await fs.rm(indexDir, { recursive: true, force: true });
  });

  it('saves the index, then reloads vectors from disk without re-embedding', async () => {
    await fs.rm(indexDir, { recursive: true, force: true });

    const writer = new RagService({
      reader: makeReader(VAULT()),
      embedder: new FakeEmbedder(),
      generator: null,
      indexFile,
      persist: true,
    });
    await writer.refresh();

    // A fresh instance must load the persisted vectors (no chunk re-embedding):
    // only the query itself is embedded.
    const loaderEmbedder = new FakeEmbedder();
    const loader = new RagService({
      reader: makeReader(VAULT()),
      embedder: loaderEmbedder,
      generator: null,
      indexFile,
      persist: true,
    });

    const res = await loader.searchCerveau({ query: 'redis pattern' });
    expect(res.success).toBe(true);
    expect(res.data.results[0].path).toBe('02-knowledge/redis/redis-pattern.md');
    // The decoded vectors must still rank correctly with a non-trivial score,
    // proving the base64 Float32 round-trip preserved the embeddings.
    expect(res.data.results[0].score).toBeGreaterThan(0);
    // Exactly one embed call: the query. Chunks came from disk.
    expect(loaderEmbedder.calls).toBe(1);
  });
});

describe('RAG — github webhook signature', () => {
  const secret = 'topsecret';
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyGithubSignature(body, signature, secret)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyGithubSignature(body, signature, 'wrong')).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
  });
});
