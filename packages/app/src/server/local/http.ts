#!/usr/bin/env node
/**
 * Local HTTP Server with OAuth 2.0
 *
 * Provides full OAuth 2.0 Authorization Code Flow with PKCE
 * Uses in-memory session storage
 * Compatible with ChatGPT and Claude
 *
 * Usage:
 *   npm run dev:http
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { GitVaultManager } from '@/services/git-vault-manager';
import { registerTools } from '@/mcp/tool-registrations';
import { registerResources } from '@/mcp/resource-registrations';
import { registerOAuthRoutes } from '@/server/shared/oauth-routes';
import { registerMcpRoute } from '@/server/shared/mcp-routes';
import { createInMemoryAuthStore, createFileAuthStore } from '@/services/auth/stores';
// Imported from its own module (not the stores barrel) so `pg` never reaches the lambda bundle.
import { createPostgresAuthStore } from '@/services/auth/stores/postgres-store';
import { setAuthStore } from '@/services/auth';
import { loadEnv, ensureEnvVars } from '@/env';
import { MCP_SERVER_INSTRUCTIONS } from '@/server/shared/instructions';
import { configureLogger } from '@/utils/logger';
import { createRagService } from '@/services/rag';
import { registerRagTools } from '@/mcp/rag-tool-registrations';
import { registerGithubWebhook } from '@/server/local/github-webhook';
import { createSynapsesService } from '@/services/synapses';
import { registerSynapsesTools } from '@/mcp/synapses-tool-registrations';
import { scheduleSynapsesDigest } from '@/services/synapses/digest-cron';
import { createGraphService } from '@/services/graph';
import { registerGraphTools } from '@/mcp/graph-tool-registrations';
import { createLearning } from '@/services/learning';
import { registerLearningTools } from '@/mcp/learning-tool-registrations';
import { scheduleWeeklyMaintenance } from '@/services/learning/maintenance-cron';
import { createReflectionService } from '@/services/reflection/reflection-service';
import { scheduleDailyReflection } from '@/services/reflection/reflection-cron';
import { ObjectiveSweepService } from '@/services/objectives/objective-sweep';
import { scheduleObjectiveSweep } from '@/services/objectives/objective-sweep-cron';
import { createNotifier } from '@/services/notify/notifier';
import { createMemoryStrength } from '@/services/memory/memory-strength';
import { createBucketStore } from '@/services/storage/bucket-store';
import { registerStorageTools } from '@/mcp/storage-tool-registrations';
import { registerUploadRoutes } from '@/server/local/upload-page';
import { registerCerveauApi } from '@/server/local/cerveau-api';
import { getSettingsStore } from '@/services/settings/settings-store';

loadEnv();

configureLogger({
  stream: process.stdout,
  minLevel: (process.env.LOG_LEVEL as any) || 'info',
});

try {
  ensureEnvVars();
} catch (error: any) {
  console.error('✗ Invalid environment configuration: %s', error.message);
  console.error('  Create a .env file (see .env.example) or export variables.');
  process.exit(1);
}

// Persistent OAuth store so redeploys don't drop the connector. Preference:
//   DATABASE_URL   → Postgres (e.g. a Railway Postgres plugin)
//   AUTH_STORE_PATH → JSON file (e.g. on a Railway Volume)
//   otherwise       → in-memory (default; lost on every restart)
const DATABASE_URL = process.env.DATABASE_URL;
const AUTH_STORE_PATH = process.env.AUTH_STORE_PATH;
setAuthStore(
  DATABASE_URL
    ? createPostgresAuthStore(DATABASE_URL)
    : AUTH_STORE_PATH
      ? createFileAuthStore(AUTH_STORE_PATH)
      : createInMemoryAuthStore(),
);

const LOCAL_VAULT_PATH = process.env.LOCAL_VAULT_PATH || './vault-local';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'obsidian-mcp-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

if (!OAUTH_CLIENT_SECRET) {
  console.error('✗ OAUTH_CLIENT_SECRET is required!');
  console.error('  Set it in .env or environment variables');
  process.exit(1);
}

const vaultManager = new GitVaultManager({
  repoUrl: process.env.VAULT_REPO!,
  branch: process.env.VAULT_BRANCH!,
  gitToken: process.env.GIT_TOKEN!,
  gitUsername: process.env.GIT_USERNAME,
  vaultPath: LOCAL_VAULT_PATH,
});

const mcpServer = new McpServer({
  name: 'obsidian-mcp',
  version: '1.0.0',
  instructions: MCP_SERVER_INSTRUCTIONS,
});

registerTools(mcpServer, () => vaultManager);
registerResources(mcpServer, () => vaultManager);

// Optional semantic RAG layer (search-cerveau / ask-cerveau). Null unless
// OPENAI_API_KEY is set — absent config leaves the existing tools untouched.
const ragService = createRagService(vaultManager);
if (ragService) {
  registerRagTools(mcpServer, ragService);
}

// Optional Synapses "thinking" layer (suggest-links / audit-coherence /
// find-themes / cerveau-digest). Needs RAG + ANTHROPIC_API_KEY.
const synapsesService = ragService ? createSynapsesService(ragService) : null;
if (synapsesService) {
  registerSynapsesTools(mcpServer, synapsesService);
}

// Optional GraphRAG layer (graph-cerveau / graph-overview). Needs RAG + ANTHROPIC_API_KEY.
const graphService = ragService ? createGraphService(ragService) : null;
if (graphService) {
  registerGraphTools(mcpServer, graphService);
}

// Optional learning loops (remember-preference / consolidate-cerveau / find-gaps).
// Also injects the feedback memory into ask-cerveau. Needs RAG + ANTHROPIC_API_KEY.
const learning = ragService ? createLearning(ragService, vaultManager) : null;
if (learning && ragService) {
  registerLearningTools(mcpServer, learning.service, learning.store);
  ragService.setLearningsProvider(() => learning.store.getLearnings());
}

// Memory strength (forgetting curve): every ask-cerveau citation reinforces the
// cited notes' traces; the daily reflection decays them and proposes archives.
const memoryStore = ragService ? createMemoryStrength() : null;
if (ragService && memoryStore) {
  ragService.setRecallListener(files => memoryStore.recordRecall(files));
}

// Optional autonomous mind (level 3): once a day the cerveau ruminates its
// persistent threads, checks its predictions, maintains its self-model and
// crystallises ripe threads — propose-only into `08-auto/`. Needs RAG +
// Synapses + Learning (so an LLM provider).
const reflection =
  ragService && synapsesService && learning
    ? createReflectionService(ragService, synapsesService, learning.service, vaultManager, {
        memory: memoryStore,
        learnings: () => learning.store.getLearnings(),
      })
    : null;

// Push channel to the human (ntfy). Null unless NTFY_TOPIC is set.
const notifier = createNotifier();

// Deterministic objective sweep (closes the vault's open loops): after each
// reindex it confronts new/changed notes with the open objectives' unmet
// conditions and stages proposals + deadline alerts under `08-auto/`.
// Pure embeddings + cosine over the existing index — no LLM required.
const objectiveSweep = ragService
  ? new ObjectiveSweepService({ rag: ragService, vault: vaultManager, notify: notifier })
  : null;

// Optional object-storage tools (put-file / get-file) backed by an S3-compatible
// bucket (e.g. a Railway Bucket). Null unless the bucket env vars are set — keeps
// binaries (images, PDFs) out of the git vault. Independent of RAG/Anthropic.
const bucketStore = createBucketStore();
if (bucketStore) {
  registerStorageTools(mcpServer, bucketStore);
}

const app = express();
// Capture the raw body so the GitHub webhook can verify its HMAC signature.
app.use(express.json({ verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
app.use(express.urlencoded({ extended: true }));

// Optional drag-and-drop upload page (browser → server → bucket). Off unless
// UPLOAD_TOKEN and a bucket are configured. The token gates GET /upload and the
// POST /upload/file endpoint.
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN;
if (bucketStore && UPLOAD_TOKEN) {
  registerUploadRoutes(app, bucketStore, UPLOAD_TOKEN);
}

// Token-gated REST API for the private cerveau-web app (Next.js on Vercel).
// Off unless CERVEAU_API_TOKEN is set. Reuses the live RAG/Synapses/Graph services.
const CERVEAU_API_TOKEN = process.env.CERVEAU_API_TOKEN;
if (ragService && CERVEAU_API_TOKEN) {
  registerCerveauApi(
    app,
    {
      rag: ragService,
      synapses: synapsesService,
      graph: graphService,
      settings: getSettingsStore(),
      reflection,
    },
    CERVEAU_API_TOKEN,
  );
}

registerOAuthRoutes(app, {
  clientId: OAUTH_CLIENT_ID,
  clientSecret: OAUTH_CLIENT_SECRET,
  baseUrl: BASE_URL,
});

registerMcpRoute(app, mcpServer);

if (ragService) {
  registerGithubWebhook(app, ragService, graphService, objectiveSweep);
}

const PORT = parseInt(process.env.PORT || '3000');

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Obsidian MCP Server (OAuth 2.0 Protected)               ║
╠═══════════════════════════════════════════════════════════╣
║  Server:     ${BASE_URL.padEnd(49)}║
║  Vault:      ${LOCAL_VAULT_PATH.padEnd(49)}║
║  Client ID:  ${OAUTH_CLIENT_ID.padEnd(49)}║
╚═══════════════════════════════════════════════════════════╝

OAuth 2.0 Endpoints:
  Authorization: ${BASE_URL}/oauth/authorize
  Token:         ${BASE_URL}/oauth/token
  Register:      ${BASE_URL}/oauth/register
  Revoke:        ${BASE_URL}/oauth/revoke
  Discovery:     ${BASE_URL}/.well-known/oauth-authorization-server

MCP Endpoint (requires Bearer token):
  POST ${BASE_URL}/mcp

Health Check:
  GET ${BASE_URL}/health

Configure ChatGPT/Claude with:
  - Client ID: ${OAUTH_CLIENT_ID}
  - Client Secret: ${OAUTH_CLIENT_SECRET}
  - Authorization URL: ${BASE_URL}/oauth/authorize
  - Token URL: ${BASE_URL}/oauth/token
  `);

  if (ragService) {
    ragService
      .ensureReady()
      .then(() => {
        console.log('✓ RAG index ready (search-cerveau / ask-cerveau)');
        if (synapsesService) {
          scheduleSynapsesDigest(synapsesService, vaultManager);
        }
        if (learning) {
          scheduleWeeklyMaintenance(learning.service, vaultManager);
        }
        if (reflection) {
          scheduleDailyReflection(reflection);
        }
        if (notifier) {
          console.log('✓ ntfy notifications enabled');
        }
        if (objectiveSweep) {
          scheduleObjectiveSweep(objectiveSweep);
          // Catch-up sweep at boot: deadlines fire by calendar, and pushes may
          // have landed while the container was down.
          objectiveSweep
            .runSweep()
            .then(s => console.log('✓ Objective sweep (boot)', s))
            .catch(error => console.error('Objective sweep (boot) failed', error));
        }
        if (graphService) {
          graphService
            .build()
            .then(g =>
              console.log(
                `✓ Knowledge graph ready (${g.entities} entities, ${g.relations} relations)`,
              ),
            )
            .catch((error: any) => console.error('✗ Graph build failed:', error?.message ?? error));
        }
      })
      .catch((error: any) => console.error('✗ RAG index build failed:', error?.message ?? error));
  }
});
