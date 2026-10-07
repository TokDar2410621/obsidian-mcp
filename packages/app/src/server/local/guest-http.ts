#!/usr/bin/env node
/**
 * Point d'entree de Dan, l'instance invitee du cerveau (lecture seule).
 *
 * Meme image Docker que l'instance perso ; le Dockerfile lance ce bundle
 * (`dist/guest/index.js`) quand GUEST_MODE=true. Voir docs/dan-invite.md.
 *
 * Variables requises : GUEST_MODE=true, VAULT_REPO, VAULT_BRANCH, GIT_TOKEN
 * (lecture seule), OAUTH_CLIENT_SECRET, BASE_URL, DATABASE_URL (base PROPRE a
 * Dan : jamais celle de l'instance perso).
 * Optionnelles : OPENAI_API_KEY (recherche + skills), une cle LLM dediee
 * (ANTHROPIC_API_KEY, ou LLM_BASE_URL + LLM_API_KEY), GUEST_LLM_MODEL,
 * GUEST_QUOTA_JOUR (defaut 100), GUEST_SERVER_NAME (defaut Dan),
 * RAG_INDEX_DIR, GITHUB_WEBHOOK_SECRET, CERVEAU_ZONES_SENSIBLES (s'ajoute).
 */

import path from 'path';
import { loadEnv } from '@/env';
import { configureLogger, logger } from '@/utils/logger';
import { GitVaultManager } from '@/services/git-vault-manager';
import { setAuthStore } from '@/services/auth';
// Modules a part (pas les barrels) : `pg` reste hors du bundle lambda.
import { createPostgresAuthStore } from '@/services/auth/stores/postgres-store';
import { createPostgresInviteStore } from '@/services/invites/postgres-invite-store';
import { estModeInvite } from '@/services/securite/zones-sensibles';
import { OpenAiEmbeddingProvider } from '@/services/rag/embeddings';
import { SettingsBackedCompleter, hasChatProvider } from '@/services/llm/settings-completer';
import { getSettingsStore } from '@/services/settings/settings-store';
import { creerAppDan } from '@/server/guest/app';

loadEnv();
configureLogger({ stream: process.stdout, minLevel: (process.env.LOG_LEVEL as any) || 'info' });

if (!estModeInvite()) {
  console.error('✗ Ce point d\'entree est celui de Dan : il exige GUEST_MODE=true.');
  process.exit(1);
}

const requises = ['VAULT_REPO', 'VAULT_BRANCH', 'GIT_TOKEN', 'OAUTH_CLIENT_SECRET', 'BASE_URL', 'DATABASE_URL'];
const manquantes = requises.filter(v => !process.env[v]?.trim());
if (manquantes.length > 0) {
  console.error(`✗ Dan : variables manquantes : ${manquantes.join(', ')}`);
  process.exit(1);
}
if (process.env.CERVEAU_JETON_LOCAL?.trim()) {
  logger.warn('Dan : CERVEAU_JETON_LOCAL est pose mais ignore (le jeton local n\'ouvre jamais Dan).');
}
if (process.env.PERSONAL_AUTH_TOKEN?.trim()) {
  logger.warn('Dan : PERSONAL_AUTH_TOKEN est pose mais ignore (seuls les codes des amis ouvrent Dan).');
}

const DATABASE_URL = process.env.DATABASE_URL!;
setAuthStore(createPostgresAuthStore(DATABASE_URL));
const { store: invites } = createPostgresInviteStore(DATABASE_URL);

const vault = new GitVaultManager({
  repoUrl: process.env.VAULT_REPO!,
  branch: process.env.VAULT_BRANCH!,
  gitToken: process.env.GIT_TOKEN!,
  gitUsername: process.env.GIT_USERNAME,
  vaultPath: process.env.LOCAL_VAULT_PATH || './vault-local',
});

const indexDir = process.env.RAG_INDEX_DIR || path.join(process.cwd(), '.rag-index');

// Le modele de Dan vit dans UNE variable (spec §1.7) ; pas de reclassement LLM.
const settings = getSettingsStore();
settings.update({
  ...(process.env.GUEST_LLM_MODEL?.trim() ? { llm: { model: process.env.GUEST_LLM_MODEL.trim() } } : {}),
  retrieval: { rerank: false },
});
const completer = hasChatProvider() ? new SettingsBackedCompleter(settings) : null;
const embedder = process.env.OPENAI_API_KEY?.trim()
  ? new OpenAiEmbeddingProvider(
      process.env.OPENAI_API_KEY.trim(),
      process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small',
    )
  : null;

const quota = Number(process.env.GUEST_QUOTA_JOUR);
const NOM = process.env.GUEST_SERVER_NAME?.trim() || 'Dan';
const BASE_URL = process.env.BASE_URL!;
const dan = creerAppDan({
  vault,
  invites,
  embedder,
  completer,
  indexDir,
  baseUrl: BASE_URL,
  clientId: process.env.OAUTH_CLIENT_ID || 'obsidian-mcp-client',
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  quotaJour: Number.isFinite(quota) && quota > 0 ? Math.floor(quota) : 100,
  nom: NOM,
});

const PORT = parseInt(process.env.PORT || '3000');
const server = dan.app.listen(PORT, () => {
  console.log(`✓ ${NOM} en ligne sur ${BASE_URL} (lecture seule, aucun cron)`);
  console.log(`  MCP : POST ${BASE_URL}/mcp   Sante : GET ${BASE_URL}/health`);
  if (!embedder) console.log('  (sans OPENAI_API_KEY : ni recherche semantique ni find-skill)');
  if (!completer) console.log('  (sans cle LLM : ni ask-cerveau, ni synapses, ni graphe)');
  dan.demarrer().catch(error => logger.error('Dan : demarrage des index en echec', { error: String(error) }));
});

const arret = (signal: string): void => {
  console.log(`Arret propre sur ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on('SIGTERM', () => arret('SIGTERM'));
process.on('SIGINT', () => arret('SIGINT'));
