/**
 * GraphRAG — a knowledge graph over the vault: entities + relations extracted
 * from notes, enabling multi-hop reasoning ("what connects X and Y?") and a
 * structural view (communities). Like RAG/Synapses, nothing here is imported by
 * `server/lambda/`, so the Anthropic SDK stays out of the Lambda bundle.
 */

export interface Relation {
  source: string;
  relation: string;
  target: string;
}

export interface GraphExtraction {
  entities: string[];
  relations: Relation[];
}

/** The LLM operations the graph needs. Injected so tests can fake it (no network). */
export interface GraphLlm {
  /** Extract entities + relations from one note's text. */
  extract(noteText: string): Promise<GraphExtraction>;
  /** Write a grounded, multi-hop answer from a graph context. */
  synthesize(question: string, context: string): Promise<string>;
}

export interface GraphNodeView {
  name: string;
  mentions: string[];
  degree: number;
}

export interface Community {
  id: number;
  entities: string[];
  size: number;
}
