# Dockerfile corrigé — déploiement Railway en mode HTTP/OAuth
#
# Corrige le bug "Cannot find package '@modelcontextprotocol/sdk'" de l'image
# officielle : celle-ci exécute un fichier compilé qui n'embarque PAS ses
# dépendances (esbuild --packages=external) et ne copie pas node_modules.
#
# On installe les dépendances, on compile le serveur HTTP en bundle (esbuild),
# puis on lance node directement dessus. node est alors PID 1 et gère SIGTERM
# proprement (arrêt gracieux, exit 0), là où npm traduisait le SIGTERM de
# remplacement en échec, d'où un faux mail "deployment crashed" à chaque deploy.

FROM node:22-slim

WORKDIR /app

# git est requis au runtime : le serveur clone/pull ton coffre via simple-git
RUN apt-get update && apt-get install -y git && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copier tout le code source du dépôt
COPY . .

# Installer les dépendances de l'app (inclut tsx) + la racine du workspace
RUN npm ci --workspace @obsidian-mcp/app --include-workspace-root --no-audit --no-fund

# Compiler le serveur HTTP en un bundle autonome (deps externes resolues depuis
# node_modules au runtime). Permet de lancer node sans npm ni tsx dans la chaine,
# donc node recoit le SIGTERM directement et applique l'arret gracieux.
RUN npm run build:http --workspace @obsidian-mcp/app

ENV LOCAL_VAULT_PATH=/app/vaults/vault-local
RUN mkdir -p /app/vaults

# RAG embedding index — MUST live OUTSIDE the vault clone: GitVaultManager runs
# `git clean fdx` on every sync, which would wipe an index stored in the vault.
# Mount a Railway volume here to keep the index across redeploys (otherwise it
# rebuilds on first boot — cheap for a small vault).
ENV RAG_INDEX_DIR=/app/index
RUN mkdir -p /app/index

EXPOSE 3000

# Démarre le serveur HTTP (OAuth) via node directement (PID 1, gère SIGTERM).
# Il lit automatiquement le PORT fourni par Railway.
CMD ["node", "packages/app/dist/http/index.js"]
