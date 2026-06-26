/**
 * Provider-agnostic chat LLM behind the cerveau's "thinking" (ask-cerveau,
 * rerank, Synapses, GraphRAG, learning). All consumers go through this one
 * primitive so the backend can be Anthropic OR any OpenAI-compatible endpoint.
 *
 * `chat()` returns the assistant's text, or '' when the model refused or
 * produced nothing — callers treat '' as "no usable answer".
 */
export interface ChatProvider {
  chat(model: string, system: string, user: string, maxTokens: number): Promise<string>;
}
