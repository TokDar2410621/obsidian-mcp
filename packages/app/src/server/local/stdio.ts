#!/usr/bin/env node
/**
 * Local MCP Server Runner
 *
 * Runs the Obsidian MCP server locally using stdio transport.
 * Perfect for testing with Claude Desktop or other MCP clients.
 *
 * Usage:
 *   npm run dev
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GitVaultManager } from '@/services/git-vault-manager';
import { registerTools } from '@/mcp/tool-registrations';
import { registerResources } from '@/mcp/resource-registrations';
import { loadEnv, ensureCoreEnvVars } from '@/env';
import { MCP_SERVER_INSTRUCTIONS } from '@/server/shared/instructions';
import { configureLogger } from '@/utils/logger';
import { createRagService } from '@/services/rag';
import { registerRagTools } from '@/mcp/rag-tool-registrations';
import { createSynapsesService } from '@/services/synapses';
import { registerSynapsesTools } from '@/mcp/synapses-tool-registrations';
import { createGraphService } from '@/services/graph';
import { registerGraphTools } from '@/mcp/graph-tool-registrations';

loadEnv();

// Configure logger to write to stderr (stdout is reserved for JSON-RPC protocol)
configureLogger({
  stream: process.stderr,
  minLevel: (process.env.LOG_LEVEL as any) || 'info',
});

try {
  ensureCoreEnvVars();
} catch (error: any) {
  console.error('Invalid environment configuration: %s', error.message);
  console.error('Create a .env file (see .env.example) or export variables.');
  process.exit(1);
}

const LOCAL_VAULT_PATH = process.env.LOCAL_VAULT_PATH || './vault-local';

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

console.error('Starting Obsidian MCP Server (local mode)...');
console.error(`Vault path: ${LOCAL_VAULT_PATH}`);

registerTools(mcpServer, () => vaultManager);
registerResources(mcpServer, () => vaultManager);

// Optional semantic RAG layer — registered only when OPENAI_API_KEY is set.
// The index is built lazily on the first search-cerveau/ask-cerveau call.
const ragService = createRagService(vaultManager);
if (ragService) {
  registerRagTools(mcpServer, ragService);
}

// Optional Synapses "thinking" layer — needs RAG + ANTHROPIC_API_KEY.
// (No weekly digest cron in stdio mode — that's an HTTP-server concern.)
const synapsesService = ragService ? createSynapsesService(ragService) : null;
if (synapsesService) {
  registerSynapsesTools(mcpServer, synapsesService);
}

// Optional GraphRAG layer — needs RAG + ANTHROPIC_API_KEY. Built lazily on first call.
const graphService = ragService ? createGraphService(ragService) : null;
if (graphService) {
  registerGraphTools(mcpServer, graphService);
}

const transport = new StdioServerTransport();
await mcpServer.connect(transport);

console.error('MCP Server running on stdio');
console.error('Ready to accept requests from MCP clients');
