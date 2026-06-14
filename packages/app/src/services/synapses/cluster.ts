import { dot, normalize } from '@/services/rag/cosine';
import { toWikilink } from '@/services/rag/chunker';
import type { EmbeddedChunk } from '@/services/rag/types';
import type { NoteVector } from '@/services/synapses/types';

/**
 * Aggregate chunk embeddings into one normalised vector per note (mean of the
 * note's chunk vectors). Also concatenates chunk bodies so callers can extract
 * the note's existing wikilinks.
 */
export function aggregateNotes(
  chunks: readonly EmbeddedChunk[],
  exclude: (file: string) => boolean = () => false,
): NoteVector[] {
  interface Acc {
    sum: number[];
    title: string;
    tags: string[];
    sample: string;
    body: string;
  }
  const byFile = new Map<string, Acc>();

  for (const chunk of chunks) {
    if (exclude(chunk.file)) continue;
    let acc = byFile.get(chunk.file);
    if (!acc) {
      acc = {
        sum: new Array(chunk.embedding.length).fill(0),
        title: chunk.title,
        tags: chunk.tags,
        sample: chunk.text,
        body: '',
      };
      byFile.set(chunk.file, acc);
    }
    for (let i = 0; i < chunk.embedding.length; i++) acc.sum[i] += chunk.embedding[i];
    acc.body += chunk.text + '\n';
  }

  const notes: NoteVector[] = [];
  for (const [file, acc] of byFile) {
    notes.push({
      file,
      title: acc.title,
      tags: acc.tags,
      wikilink: toWikilink(file),
      embedding: normalize(acc.sum),
      sample: acc.sample,
      body: acc.body,
    });
  }
  return notes;
}

/**
 * Connected-components clustering: notes are joined by an edge when their
 * cosine similarity is ≥ `threshold`. Returns the components (each a list of
 * notes), largest first. Parameter-light and deterministic.
 */
export function clusterNotes(notes: NoteVector[], threshold: number): NoteVector[][] {
  const n = notes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dot(notes[i].embedding, notes[j].embedding) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, NoteVector[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(notes[i]);
    else groups.set(root, [notes[i]]);
  }

  return [...groups.values()].sort((a, b) => b.length - a.length);
}
