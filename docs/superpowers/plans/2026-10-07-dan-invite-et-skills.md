# Dan invité et skills intégrés : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** une instance « Dan » en lecture seule pour 3 amis (auth par ami, quota, audit, index sans zones cachées), un catalogue de skills avec find-skill / read-skill, et un profil neutre pour le cerveau de chaque ami.

**Architecture:** un point d'entrée séparé `server/local/guest-http.ts` (bundle `dist/guest`) qui n'importe aucun cron. La sécurité invitée tient dans un décorateur `VaultInvite` (lecture seule, zones cachées indiscernables d'un fichier absent) : l'index RAG, le graphe et les synapses sont construits à travers lui. Un Proxy `serveurInvite` applique la liste blanche d'outils, le quota et l'audit. L'instance perso gagne find-skill / read-skill, une route d'admin qui écrit le catalogue en UN commit, et rejette les tokens d'invités.

**Tech Stack:** TypeScript, Express, @modelcontextprotocol/sdk, vitest + supertest, pg, esbuild.

**Spec:** `05-projects/cerveau/2026-10-07-cerveau-invite-et-skills.md` (vault cerveau).

## Global Constraints

- Zéro em-dash dans toute prose produite (code user-facing, docs, commits).
- L'instance perso (`GUEST_MODE` absent) garde son comportement ; seules exceptions : `09-skills/` exclu du RAG général, find-skill / read-skill ajoutés, tokens portant `inviteId` refusés.
- `GUEST_MODE=true` : aucun cron, aucune notif, aucune écriture vault, aucun jeton local, aucun `PERSONAL_AUTH_TOKEN`.
- Zones cachées invité = `00-personnel/`, `04-people/`, `01-raw/docs/`, `01-raw/admin/`, `Personnes/` ∪ `CERVEAU_ZONES_SENSIBLES`.
- Quota `GUEST_QUOTA_JOUR` (défaut 100), jour civil America/Montreal.
- Aucun secret dans une URL ni dans les logs.

## Review Focus

1. read-notes avec un mélange chemin caché / chemin absent : les deux entrées doivent être identiques (pas de compteur `masques_zone_sensible`).
2. Dossier caché listé comme répertoire (`Personnes` sans slash) : absent de list-files-in-vault avec `includeDirectories`.
3. Chemins détournés (`./00-personnel/x.md`, `00-personnel//x.md`, `..`) : message générique.
4. Refresh OAuth d'un ami révoqué pendant la fenêtre de grâce : refusé.
5. Token perso présenté à l'instance invitée (store partagé par erreur) : 401.

---

### Task 1: zones, appelant et VaultInvite
- Modify `services/securite/zones-sensibles.ts` : `estModeInvite()`, zones invitées (union), `filtrerResultats` toujours actif en invité, `deverrouiller` faux en invité.
- Modify `services/securite/appelant.ts` : origine `'invite'`, champ `invite?: { id; nom }`.
- Create `services/invites/vault-invite.ts` : décorateur lecture seule, message générique `MESSAGE_INTROUVABLE`.
- Modify `services/rag/rag-service.ts` : pas de `masques_zone_sensible` ni de message « déverrouille » en invité.
- Tests `tests/behavior/vault-invite.spec.ts`.

### Task 2: auth par ami
- Modify `services/auth/stores/types.ts` (+`inviteId?` sur session, code, access, refresh), stores in-memory / file / postgres (refresh hérite de `inviteId`).
- Modify `session-manager.ts` (vérificateur de connexion injectable), `oauth-tokens.ts` (`inviteId` propagé, `getValidAccessToken`, `accepter` au refresh), `oauth-routes.ts` (options `verifierConnexion`, `accepterRafraichissement`, `titreConnexion`), `ui/oauth-pages.ts` (titre).
- Modify `server/shared/mcp-routes.ts` : perso refuse les tokens `inviteId`, gestionnaire MCP partagé.
- Create `services/invites/invite-store.ts` (interface, mémoire, Postgres, secrets, jour Montréal).
- Tests `tests/behavior/invites-auth.spec.ts`.

### Task 3: serveur invité
- Create `services/invites/serveur-invite.ts` (liste blanche, quota, audit, descriptions Dan).
- Modify `server/shared/instructions.ts` (+`DAN_INSTRUCTIONS`).
- Create `server/guest/app.ts` (`creerAppInvite`) et `server/local/guest-http.ts` (boot).
- Modify `server/local/github-webhook.ts` (organe `rafraichirEnPlus`).
- Modify `server/local/http.ts` (refus si `GUEST_MODE=true`).
- Create `scripts/invites.ts` (CLI) ; build `dist/guest`, `dist/invites` ; Dockerfile.
- Tests `tests/http/dan-invite.spec.ts` (critères d'acceptation 1 à 5, 8 à 10).

### Task 4: skills
- Modify `services/rag/vault-reader.ts` (exclusions, `09-skills/` exclu du général).
- Create `services/skills/skills-service.ts`, `mcp/skills-tool-registrations.ts`.
- Modify `services/git-vault-manager.ts` (+`remplacerDossier`), `vault-manager.ts` (méthode optionnelle).
- Create `server/local/skills-catalog-route.ts` (`POST /admin/skills-catalog`, jeton local).
- Create `scripts/sync-skills-catalog.ts` + `scripts/skills-curated.txt`.
- Tests `tests/behavior/skills.spec.ts`, `tests/unit/sync-skills-catalog.spec.ts`.

### Task 5: profil neutre et starter-vault
- Modify `server/local/http.ts` : `CERVEAU_PROFIL=neutre` coupe crons, passages de boot et rappel motivé sauf flag `on`.
- Create `starter-vault/` et `docs/dan-invite.md` (déploiement, CLI, appel de 30 minutes).
- Test `tests/unit/profil-neutre.spec.ts`.

### Task 6: vérifications réelles
- Script `scripts/verifier-fuite-invite.ts` sur le vrai coffre (lecture seule, embeddings factices + BM25).
- Synchro `--out` sur PC1, find-skill « debug python » avec de vrais embeddings.
- Suite complète, tsc, build esbuild.
