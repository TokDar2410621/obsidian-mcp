import { describe, expect, it } from 'vitest';
import { OpenAiEmbeddingProvider, waitBeforeRetry } from '@/services/rag/embeddings';

/**
 * Le 2026-10-08, la premiere indexation de Dan a touche la limite de 1 M de
 * tokens par minute de l'organisation OpenAI : un seul 429 faisait tomber
 * toute l'indexation. Ces tests epinglent la reprise.
 */

function reponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const OK = { data: [{ embedding: [1, 0] }] };
const LIMITE =
  '{"error":{"message":"Rate limit reached for text-embedding-3-small on tokens per min (TPM): Limit 1000000. Please try again in 1.234s."}}';

describe('waitBeforeRetry', () => {
  it('suit Retry-After, puis l indice du message, puis le backoff', () => {
    expect(waitBeforeRetry(0, '2', '')).toBe(2250);
    expect(waitBeforeRetry(0, null, LIMITE)).toBe(1484);
    expect(waitBeforeRetry(0, null, 'Please try again in 250ms')).toBe(500);
    expect(waitBeforeRetry(3, null, 'rien')).toBe(8000);
    expect(waitBeforeRetry(20, null, 'rien')).toBe(60_000);
  });
});

describe('OpenAiEmbeddingProvider', () => {
  it('reprend apres des 429 et finit par rendre les vecteurs', async () => {
    const attentes: number[] = [];
    const reponses = [reponse(429, LIMITE), reponse(429, LIMITE), reponse(200, OK)];
    const p = new OpenAiEmbeddingProvider('cle', 'modele', {
      fetchImpl: (async () => reponses.shift()!) as typeof fetch,
      sleep: async ms => void attentes.push(ms),
    });
    expect(await p.embed(['texte'])).toEqual([[1, 0]]);
    expect(attentes).toEqual([1484, 1484]);
  });

  it('reprend aussi sur une erreur 5xx', async () => {
    const reponses = [reponse(503, 'indisponible'), reponse(200, OK)];
    const p = new OpenAiEmbeddingProvider('cle', 'modele', {
      fetchImpl: (async () => reponses.shift()!) as typeof fetch,
      sleep: async () => undefined,
    });
    expect(await p.embed(['texte'])).toEqual([[1, 0]]);
  });

  it('abandonne sans reprise sur une erreur definitive (401)', async () => {
    let appels = 0;
    const p = new OpenAiEmbeddingProvider('cle', 'modele', {
      fetchImpl: (async () => {
        appels++;
        return reponse(401, 'cle invalide');
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(p.embed(['texte'])).rejects.toThrow('(401)');
    expect(appels).toBe(1);
  });

  it('abandonne apres 8 tentatives sur 429', async () => {
    let appels = 0;
    const p = new OpenAiEmbeddingProvider('cle', 'modele', {
      fetchImpl: (async () => {
        appels++;
        return reponse(429, LIMITE);
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(p.embed(['texte'])).rejects.toThrow('(429)');
    expect(appels).toBe(8);
  });

  it('garde la compatibilite avec une URL de base en troisieme argument', async () => {
    let url = '';
    const p = new OpenAiEmbeddingProvider('cle', 'modele', 'https://exemple.test/v1');
    (p as any).fetchImpl = async (u: string) => {
      url = u;
      return reponse(200, OK);
    };
    await p.embed(['texte']);
    expect(url).toBe('https://exemple.test/v1/embeddings');
  });
});
