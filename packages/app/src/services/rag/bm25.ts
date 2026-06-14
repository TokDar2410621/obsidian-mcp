/**
 * Minimal BM25 lexical index over a fixed document set (the note chunks), plus
 * Reciprocal Rank Fusion. Used to make retrieval *hybrid*: BM25 catches exact
 * terms (names, ids, jargon) that dense embeddings miss, and RRF blends the two
 * rankings. Pure in-memory, no dependency — the corpus is small.
 */

const K1 = 1.5;
const B = 0.75;

/** Lowercase, strip accents, split on non-alphanumerics, drop trivial tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && t.length <= 40);
}

interface Doc {
  len: number;
  tf: Map<string, number>;
}

export class BM25Index {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private readonly n: number;
  private avgdl = 0;

  constructor(texts: string[]) {
    this.n = texts.length;
    let total = 0;
    for (const text of texts) {
      const tf = new Map<string, number>();
      const tokens = tokenize(text);
      for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      this.docs.push({ len: tokens.length, tf });
      total += tokens.length;
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.avgdl = this.n > 0 ? total / this.n : 0;
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  /** BM25 score for each candidate doc index against the query (>0 only). */
  score(query: string, candidates: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (this.avgdl === 0) return out;
    const qterms = [...new Set(tokenize(query))];
    for (const i of candidates) {
      const doc = this.docs[i];
      if (!doc) continue;
      let s = 0;
      for (const term of qterms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        s += (this.idf(term) * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * doc.len) / this.avgdl));
      }
      if (s > 0) out.set(i, s);
    }
    return out;
  }
}

/** Reciprocal Rank Fusion of several best-first id rankings. */
export function rrf(rankings: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!);
}
