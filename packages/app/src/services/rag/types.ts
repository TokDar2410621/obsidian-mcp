/**
 * Shared types for the semantic RAG layer (search-cerveau / ask-cerveau).
 *
 * The RAG layer is additive and isolated: nothing under `services/rag` (or the
 * tools that use it) is imported by `server/lambda/`, so the Anthropic SDK and
 * the embedding/index machinery never enter the bundled Lambda build.
 */

/** A unit of text extracted from a note, before embedding. */
export interface Chunk {
  /** Stable id: `${file}#${index}`. */
  id: string;
  /** Vault-relative path of the source note (e.g. `05-projects/foo/_index.md`). */
  file: string;
  /** Note title (frontmatter `title`, first `# H1`, or filename). */
  title: string;
  /** Heading path within the note (e.g. `## Decisions`); empty for the intro section. */
  heading: string;
  /** Frontmatter tags. */
  tags: string[];
  /** Embedded + displayed text (includes a title/heading header line). */
  text: string;
  /** sha256 of `text` — drives incremental re-embedding. */
  hash: string;
}

/** A chunk with its (L2-normalised) embedding vector. */
export interface EmbeddedChunk extends Chunk {
  embedding: Float32Array;
}

/** Produces embedding vectors for text. Injected so tests can fake it. */
export interface EmbeddingProvider {
  readonly model: string;
  /** Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** A retrieved chunk passed to the answer generator. */
export interface GenContext {
  path: string;
  wikilink: string;
  heading: string;
  text: string;
}

export interface GenResult {
  answer: string;
  /** True when the model declined (Anthropic `stop_reason: "refusal"`). */
  refused: boolean;
}

/** Generates a grounded answer from retrieved context. Injected for testability. */
export interface AnswerGenerator {
  readonly model: string;
  generate(question: string, contexts: GenContext[]): Promise<GenResult>;
}

/**
 * Reads markdown out of the vault for indexing. The production implementation
 * lists once (one git sync) then reads straight off disk to avoid the N+1 git
 * hard-resets that calling `VaultManager.readFile` per file would trigger.
 */
export interface VaultReader {
  listMarkdownFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface SearchHit {
  path: string;
  wikilink: string;
  heading: string;
  tags: string[];
  score: number;
  excerpt: string;
  /** Full chunk text (internal — not surfaced in tool output). */
  text: string;
}

export interface RefreshResult {
  files: number;
  chunks: number;
  /** How many chunks were sent to the embedding API this run. */
  embedded: number;
}
