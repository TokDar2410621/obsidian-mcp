# Dockerfile corrigé — déploiement Railway en mode HTTP/OAuth
#
# Corrige le bug "Cannot find package '@modelcontextprotocol/sdk'" de l'image
# officielle : celle-ci exécute un fichier compilé qui n'embarque PAS ses
# dépendances (esbuild --packages=external) et ne copie pas node_modules.
#
# Ici on installe les dépendances et on lance le serveur via tsx (code source),
# ce qui démarre proprement. Testé : le serveur HTTP démarre et écoute.

FROM node:22-slim

WORKDIR /app

# git est requis au runtime : le serveur clone/pull ton coffre via simple-git
RUN apt-get update && apt-get install -y git && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copier tout le code source du dépôt
COPY . .

# Installer les dépendances de l'app (inclut tsx) + la racine du workspace
RUN npm ci --workspace @obsidian-mcp/app --include-workspace-root --no-audit --no-fund

ENV LOCAL_VAULT_PATH=/app/vaults/vault-local
RUN mkdir -p /app/vaults

EXPOSE 3000

# Démarre le serveur HTTP (OAuth). Il lit automatiquement le PORT fourni par Railway.
CMD ["npm", "run", "dev:http"]
