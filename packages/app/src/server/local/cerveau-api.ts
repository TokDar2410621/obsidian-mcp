import type { Express, Request, Response, NextFunction } from 'express';
import type { RagService } from '@/services/rag/rag-service';
import type { SynapsesService } from '@/services/synapses';
import type { GraphService } from '@/services/graph';
import type { SettingsStore } from '@/services/settings/settings-store';
import type { ToolResponse } from '@/mcp/handlers/types';

export interface CerveauApiDeps {
  rag: RagService;
  synapses: SynapsesService | null;
  graph: GraphService | null;
  settings: SettingsStore;
}

/**
 * Token-gated REST API for the private `cerveau-web` app (Next.js on Vercel).
 * Separate from the OAuth-protected `/mcp` endpoint: gated by a single bearer
 * token (`CERVEAU_API_TOKEN`) the web app keeps server-side. CORS is opened to
 * `CERVEAU_CORS_ORIGIN` (the Vercel URL) for direct browser calls if ever needed.
 */
export function registerCerveauApi(app: Express, deps: CerveauApiDeps, token: string): void {
  const { rag, synapses, graph, settings } = deps;
  const corsOrigin = process.env.CERVEAU_CORS_ORIGIN || '*';

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // --- chat / search / graph -------------------------------------------------
  app.post('/api/ask', (req, res) =>
    run(res, () => {
      const b = req.body ?? {};
      if (typeof b.question !== 'string' || !b.question.trim())
        throw new HttpError(400, 'question is required');
      const s = settings.get();
      return rag.askCerveau({
        question: b.question,
        top_k: numOr(b.top_k, s.retrieval.topK),
        folder: strOr(b.folder) ?? (s.filters.folder || undefined),
        tags: tagsOr(b.tags) ?? (s.filters.tags.length ? s.filters.tags : undefined),
      });
    }),
  );

  app.post('/api/search', (req, res) =>
    run(res, () => {
      const b = req.body ?? {};
      if (typeof b.query !== 'string' || !b.query.trim())
        throw new HttpError(400, 'query is required');
      const s = settings.get();
      return rag.searchCerveau({
        query: b.query,
        top_k: numOr(b.top_k, s.retrieval.topK),
        folder: strOr(b.folder) ?? (s.filters.folder || undefined),
        tags: tagsOr(b.tags) ?? (s.filters.tags.length ? s.filters.tags : undefined),
      });
    }),
  );

  app.post('/api/graph', (req, res) =>
    run(res, () => {
      if (!graph) throw new HttpError(503, 'graph layer unavailable');
      const b = req.body ?? {};
      if (typeof b.question !== 'string' || !b.question.trim())
        throw new HttpError(400, 'question is required');
      return graph.graphAsk({ question: b.question, depth: numOr(b.depth, undefined) });
    }),
  );

  // --- dashboard -------------------------------------------------------------
  app.get('/api/themes', (req, res) =>
    run(res, () => {
      if (!synapses) throw new HttpError(503, 'synapses layer unavailable');
      return synapses.findThemes({
        folder: strOr(req.query.folder),
        min_cluster_size: numOr(req.query.min_cluster_size, undefined),
      });
    }),
  );

  app.get('/api/overview', (_req, res) =>
    run(res, () => {
      if (!graph) throw new HttpError(503, 'graph layer unavailable');
      return graph.graphOverview({});
    }),
  );

  app.get('/api/graph-data', (req, res) =>
    run(res, () => {
      if (!graph) throw new HttpError(503, 'graph layer unavailable');
      return graph.graphData({ limit: numOr(req.query.limit, undefined) });
    }),
  );

  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      await rag.ensureReady();
      const chunks = rag.embeddedChunks;
      const notes = new Set(chunks.map(c => c.file)).size;
      let entities = 0;
      let relations = 0;
      if (graph) {
        const ov = await graph.graphOverview({});
        if (ov.success && ov.data) {
          entities = Number((ov.data as Record<string, unknown>).entities) || 0;
          relations = Number((ov.data as Record<string, unknown>).relations) || 0;
        }
      }
      res.json({ notes, chunks: chunks.length, entities, relations, canGenerate: rag.canGenerate });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  // --- settings --------------------------------------------------------------
  app.get('/api/settings', (_req: Request, res: Response) => res.json(settings.get()));
  app.put('/api/settings', (req: Request, res: Response) => res.json(settings.update(req.body)));

  app.get('/api/health', (_req: Request, res: Response) => res.json({ ok: true }));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function run(res: Response, fn: () => Promise<ToolResponse>): Promise<void> {
  try {
    const r = await fn();
    if (r.success) res.json(r.data);
    else res.status(500).json({ error: r.error });
  } catch (error: any) {
    const status = error instanceof HttpError ? error.status : 500;
    res.status(status).json({ error: error?.message ?? String(error) });
  }
}

function numOr(v: unknown, fallback: number | undefined): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function strOr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function tagsOr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const tags = v.map(t => String(t).trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}
