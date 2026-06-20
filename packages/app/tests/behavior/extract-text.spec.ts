import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTextExtractor } from '@/services/rag/extract-text';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('RAG text extractor', () => {
  it('reads markdown / plain-text files as UTF-8 (no PDF parsing)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'extract-'));
    const md = path.join(dir, 'note.md');
    writeFileSync(md, '# Title\n\nbody', 'utf-8');

    const extract = makeTextExtractor(async () => ({ text: 'SHOULD NOT BE USED' }));
    expect(await extract(md)).toBe('# Title\n\nbody');
  });

  it('extracts text from PDFs via the injected parser', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'extract-'));
    const pdf = path.join(dir, 'paper.pdf');
    writeFileSync(pdf, '%PDF-1.4 fake bytes');

    let received: Buffer | null = null;
    const extract = makeTextExtractor(async data => {
      received = data;
      return { text: 'extracted pdf text' };
    });

    expect(await extract(pdf)).toBe('extracted pdf text');
    expect(received).toBeInstanceOf(Buffer);
  });

  it('matches the .pdf extension case-insensitively', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'extract-'));
    const pdf = path.join(dir, 'Paper.PDF');
    writeFileSync(pdf, 'bytes');

    const extract = makeTextExtractor(async () => ({ text: 'ok' }));
    expect(await extract(pdf)).toBe('ok');
  });
});
