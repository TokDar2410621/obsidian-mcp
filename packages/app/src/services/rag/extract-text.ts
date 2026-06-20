import { promises as fs } from 'fs';
// pdf-parse's package entry self-executes a debug file read on import (throws in
// a bundle); the lib subpath is the clean programmatic entry point.
// @ts-expect-error - the internal subpath ships no type declarations
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/** Parses a PDF buffer to text. Matches the shape of `pdf-parse`. */
export type PdfParse = (data: Buffer) => Promise<{ text: string }>;

const PDF_EXT = /\.pdf$/i;

/**
 * Build the RAG indexer's text extractor. PDFs are parsed to plain text;
 * everything else (Markdown, plain text) is read as UTF-8. The PDF parser is
 * injected so tests can fake it without a binary PDF fixture.
 */
export function makeTextExtractor(parsePdf: PdfParse) {
  return async function extractText(absPath: string): Promise<string> {
    if (PDF_EXT.test(absPath)) {
      const data = await fs.readFile(absPath);
      const { text } = await parsePdf(data);
      return text ?? '';
    }
    return fs.readFile(absPath, 'utf-8');
  };
}

/** Default extractor wired to `pdf-parse`. */
export const extractText = makeTextExtractor(pdfParse as PdfParse);
