import crypto from 'crypto';
import type { Chunk } from '@/services/rag/types';

const MAX_CHARS = 2000; // ~512 tokens
const OVERLAP_CHARS = 256; // ~64 tokens

interface ParsedNote {
  title?: string;
  tags: string[];
  body: string;
}

/**
 * Minimal YAML-frontmatter extractor. The vault frontmatter is simple
 * (`title`, `tags: [a, b]` or a block list), so a full YAML parser is overkill.
 * Anything we don't recognise is ignored — only `title` and `tags` matter here.
 */
export function parseNote(content: string): ParsedNote {
  if (!content.startsWith('---')) {
    return { tags: [], body: content };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { tags: [], body: content };
  }
  const block = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, '');

  let title: string | undefined;
  const tags: string[] = [];
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const titleMatch = line.match(/^title:\s*(.+)$/i);
    if (titleMatch) {
      title = stripQuotes(titleMatch[1].trim());
      continue;
    }
    const inlineTags = line.match(/^tags:\s*\[(.*)\]\s*$/i);
    if (inlineTags) {
      for (const t of inlineTags[1].split(',')) {
        const tag = stripQuotes(t.trim());
        if (tag) tags.push(tag);
      }
      continue;
    }
    if (/^tags:\s*$/i.test(line)) {
      // Block list: subsequent `  - tag` lines.
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s*-\s*(.+)$/);
        if (!item) break;
        const tag = stripQuotes(item[1].trim());
        if (tag) tags.push(tag);
        i = j;
      }
    }
  }
  return { title, tags, body };
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/** Filename without extension — what Obsidian uses for `[[wikilinks]]`. */
export function toWikilink(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.md$/i, '');
}

/** Split a note into embeddable chunks (heading-aware, with windowing). */
export function chunkNote(filePath: string, content: string): Chunk[] {
  const parsed = parseNote(content);
  const title = parsed.title || firstHeading(parsed.body) || toWikilink(filePath);

  const sections = splitByHeadings(parsed.body);
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    const sectionBody = section.body.trim();
    if (!sectionBody) continue;
    const header = section.heading ? `${title} › ${section.heading}` : title;

    for (const window of windowText(sectionBody)) {
      const text = `${header}\n\n${window}`;
      chunks.push({
        id: `${filePath}#${index}`,
        file: filePath,
        title,
        heading: section.heading,
        tags: parsed.tags,
        text,
        hash: crypto.createHash('sha256').update(text).digest('hex'),
      });
      index++;
    }
  }

  return chunks;
}

function firstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

interface Section {
  heading: string;
  body: string;
}

function splitByHeadings(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let current: Section = { heading: '', body: '' };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current.heading || current.body.trim()) sections.push(current);
      current = { heading: headingMatch[1].trim(), body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.heading || current.body.trim()) sections.push(current);

  return sections;
}

/** Slide a window over long text so no chunk exceeds the embedding budget. */
function windowText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const windows: string[] = [];
  let start = 0;
  while (start < text.length) {
    windows.push(text.slice(start, start + MAX_CHARS));
    if (start + MAX_CHARS >= text.length) break;
    start += MAX_CHARS - OVERLAP_CHARS;
  }
  return windows;
}
