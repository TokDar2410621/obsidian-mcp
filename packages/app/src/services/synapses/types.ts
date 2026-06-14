/**
 * Synapses — the "thinking" layer over the RAG embedding index.
 *
 * It reuses {@link RagService}'s in-memory note embeddings to surface
 * connections the vault doesn't make explicit: missing links, contradictions /
 * stale decisions / duplicates, and emergent cross-project themes.
 *
 * Like the RAG layer, nothing here is imported by `server/lambda/`, so the
 * Anthropic SDK + node-cron stay out of the bundled Lambda build.
 */

/** Free-form LLM completion. Injected so tests can fake it (no network). */
export interface LlmCompleter {
  readonly model: string;
  /** Returns the completion text (empty string on refusal). */
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
}

/** A note aggregated to a single (L2-normalised) vector + metadata. */
export interface NoteVector {
  /** Vault-relative path. */
  file: string;
  title: string;
  tags: string[];
  /** Obsidian wikilink name (filename without extension). */
  wikilink: string;
  /** Mean of the note's chunk embeddings, re-normalised. */
  embedding: Float32Array;
  /** Representative text for LLM prompts (the note's first chunk). */
  sample: string;
  /** Concatenated chunk bodies — used to extract existing wikilinks. */
  body: string;
}

export interface LinkSuggestion {
  a: string;
  b: string;
  score: number;
  reason: string;
  liaison: string;
}

export interface CoherenceIssue {
  type: 'contradiction' | 'stale' | 'duplicate';
  a: string;
  b: string;
  score: number;
  explanation: string;
}

export interface Theme {
  name: string;
  summary: string;
  notes: string[];
  emerging: boolean;
}
