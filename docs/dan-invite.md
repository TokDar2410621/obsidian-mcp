# Dan : le cerveau invité et les skills intégrés

Runbook de la spec « Cerveau invité et skills intégrés » (vault : `05-projects/cerveau/2026-10-07-cerveau-invite-et-skills.md`). Chaque étape qui touche la production attend le OK de Darius.

## Ce qui existe

- **Dan** (`dist/guest/index.js`) : une instance en lecture seule du cerveau, pour les amis. Même image Docker que l'instance perso, lancée quand `GUEST_MODE=true`. Aucun cron, aucune notif, aucune écriture. Les zones `00-personnel/`, `04-people/`, `Personnes/`, `Journal/`, `03-daily/`, `01-raw/`, `09-taches/` et `09-archive/` y sont invisibles (décisions Q4, Q14 et Q15 du 2026-10-07), comme tout chemin dont un segment commence par un point (`.git/`, `.obsidian/`) et tout ce qui n'est pas une note `.md` (journaux techniques, JSON, PDF). Un chemin caché se comporte exactement comme un chemin absent : même message, même coût. Dans ce qui reste visible, courriels, téléphones, adresses, codes postaux, numéros de documents, liens de réunion, codes et clés sont masqués à chaque lecture, index compris. Audit du coffre réel du 2026-10-07 : 1 160 notes servies, zéro courriel, téléphone, adresse ou secret résiduel (`verifier-dan exporter`, puis un audit indépendant).
- **OAuth de Dan** : un code n'est renvoyé qu'au rappel de claude.ai (`https://claude.ai/api/mcp/auth_callback`, ou claude.com) et à la boucle locale de Claude Code ; PKCE S256 obligatoire. `GUEST_REDIRECT_URIS` ajoute des adresses exactes si un autre client doit se brancher.
- **Codes d'accès par ami**, révocables un par un (CLI `invites`), quota quotidien, journal d'audit.
- **find-skill / read-skill** sur les deux instances, sur un catalogue curé écrit dans `09-skills/`.
- **Profil neutre** (`CERVEAU_PROFIL=neutre`) pour le cerveau d'un ami.

## Ordre de mise en production

1. Merger la PR. L'instance perso se redéploie : suivre `railway logs -s obsidian-mcp` jusqu'au boot sain (`✓ RAG index ready`, `✓ Catalogue de skills pret (0 skills)`).
2. Écrire le catalogue dans le coffre (section « Catalogue »).
3. Créer le service Dan (section « Déployer Dan »).
4. Créer les codes des amis et leur envoyer le message (section « Les amis »).

## Catalogue de skills

La liste curée vit dans `packages/app/src/cli/skills-curated.txt` (89 skills au 2026-10-07 : superpowers, Matt Pocock, marketing de Corey Haines, skills de Darius sous MIT). Pour en ajouter un, l'ajouter à la liste, puis relancer.

Aperçu local, sans rien écrire dans le coffre :

```bash
npx tsx packages/app/src/cli/sync-skills-catalog.ts --out ./apercu-skills
```

Écriture dans le coffre, en UN commit, par la route `POST /admin/skills-catalog` de l'instance perso. `railway run` injecte `CERVEAU_JETON_LOCAL` sans l'afficher :

```bash
cd obsidian-mcp   # dossier lié au projet gracious-joy
railway run -s obsidian-mcp -- npx tsx packages/app/src/cli/sync-skills-catalog.ts \
  --server https://obsidian-mcp-production-26b6.up.railway.app
```

Le push déclenche le webhook : les deux instances réindexent le catalogue seules.

## Déployer Dan

Dans le projet Railway `gracious-joy`, à côté de `obsidian-mcp` :

1. **Une base à part.** `railway add --database postgres`. Dan ne doit JAMAIS pointer sur la base de l'instance perso : avec un store partagé, les tokens existeraient des deux côtés. Le code refuse de toute façon un token perso chez Dan et un token d'ami chez le perso, mais deux bases restent la vraie séparation.
2. **Le service.** `railway add --service dan --repo TokDar2410621/obsidian-mcp`, puis un domaine (`railway domain -s dan`) et un volume monté sur `/app/index` (`railway volume add -m /app/index`, service `dan` lié).
3. **Un jeton GitHub en lecture seule.** Fine-grained PAT, accès au seul dépôt du coffre, permission `Contents: Read-only`. Dan ne pousse jamais rien ; ce jeton garantit qu'il ne le pourrait pas.
4. **Les variables** (`railway variable set -s dan ...`) :

| Variable | Valeur |
|---|---|
| `GUEST_MODE` | `true` |
| `VAULT_REPO`, `VAULT_BRANCH` | les mêmes que l'instance perso |
| `GIT_TOKEN` | le PAT en lecture seule (étape 3) |
| `DATABASE_URL` | la référence à la NOUVELLE base, ex. `${{Postgres-xxxx.DATABASE_URL}}` |
| `BASE_URL` | `https://<domaine de dan>` |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | nouveaux, propres à Dan |
| `OPENAI_API_KEY` | une clé DÉDIÉE (projet OpenAI « Dan ») : la facture des amis se lit à part |
| `ANTHROPIC_API_KEY` | une clé DÉDIÉE, ou `LLM_BASE_URL` + `LLM_API_KEY` |
| `GUEST_LLM_MODEL` | un modèle économique, capacités vérifiées avant (règle `verifier-capacites-avant-migration-modele`) |
| `GUEST_QUOTA_JOUR` | `100` |
| `GUEST_SERVER_NAME` | `Dan` |
| `GUEST_REDIRECT_URIS` | facultatif : redirect_uri exactes en plus de claude.ai et de la boucle locale |
| `GITHUB_WEBHOOK_SECRET` | nouveau secret |

À NE PAS poser sur Dan : `CERVEAU_JETON_LOCAL`, `PERSONAL_AUTH_TOKEN`, `CERVEAU_MOT_DE_PASSE`, `NTFY_TOPIC`, `CAPTURE_TOKEN`, `CERVEAU_API_TOKEN`, `STRIPE_API_KEY`, `GOOGLE_OAUTH_*`, les variables du bucket. Dan ignore le jeton local et le jeton personnel même s'ils sont posés, et le dit dans ses logs.

5. **Le webhook.** Dans le dépôt du coffre sur GitHub : un SECOND webhook vers `https://<domaine de dan>/webhook/github`, `application/json`, événement `push`, secret = `GITHUB_WEBHOOK_SECRET` de Dan.
6. **Le premier boot.** Suivre `railway logs -s dan` jusqu'à `Dan : aucun cron`, `Dan : index pret`, `Dan : catalogue de skills pret`. Coûts du premier boot : environ 0,15 $ d'embeddings (1 945 notes) et quelques dollars de LLM pour le graphe ; ensuite seuls les deltas sont recalculés.
7. **La vérification.** `curl https://<domaine de dan>/health` répond `ok`. Un appel MCP sans token rend 401.

## Les amis

La CLI tourne DANS le conteneur de Dan, sur sa base :

```bash
railway ssh -s dan -- node packages/app/dist/invites/index.js create Paul
railway ssh -s dan -- node packages/app/dist/invites/index.js list
railway ssh -s dan -- node packages/app/dist/invites/index.js revoke Paul
railway ssh -s dan -- node packages/app/dist/invites/index.js audit Paul 7
```

Le code d'accès s'affiche une seule fois. Perdu : `revoke`, puis `create` à nouveau.

Ce que reçoit chaque ami :

1. L'URL : `https://<domaine de dan>/mcp`.
2. Son code d'accès, dans un message séparé ou de vive voix.
3. Le branchement :
   - claude.ai : Paramètres, Connecteurs, Ajouter un connecteur personnalisé, nom « Dan », l'URL. La page de connexion demande le code.
   - Claude Code : `claude mcp add --transport http dan https://<domaine de dan>/mcp`, puis `/mcp` pour se connecter.

## Le cerveau d'un ami (appel de 30 minutes)

Sur SES comptes ; il paie ses clés ; Darius ne garde aucun accès après l'appel.

1. Comptes : GitHub, Railway, OpenAI, un fournisseur LLM.
2. Le coffre : un dépôt GitHub privé initialisé avec le contenu de `starter-vault/`.
3. Le service : déployer ce dépôt (obsidian-mcp) sur son Railway, avec une base Postgres, un volume sur `/app/index`, et `CERVEAU_PROFIL=neutre` (tous les crons coupés ; il rallume ce qu'il veut avec un flag `on`).
4. Variables : `VAULT_REPO`, `VAULT_BRANCH=main`, `GIT_TOKEN` (lecture et écriture sur SON coffre), `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `PERSONAL_AUTH_TOKEN` (son mot de passe de connexion), `BASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`, sa clé LLM, `JOURNAL_PATH_TEMPLATE=03-daily/{{date}}.md`, `JOURNAL_DATE_FORMAT=yyyy-MM-dd`, `JOURNAL_ACTIVITY_SECTION=## Journal`, `JOURNAL_FILE_TEMPLATE=_templates/daily.md`.
5. Logs suivis jusqu'au boot sain.
6. Dans son Claude, deux connecteurs : « Mon cerveau » (son instance) et « Dan ».
7. Test : une note écrite chez lui, une recherche chez Dan.

## Vérifications rejouables

```bash
cd packages/app
npx vitest run tests/http/dan-invite.spec.ts tests/behavior/vault-invite.spec.ts tests/behavior/skills.spec.ts

# Anti-fuite sur un vrai coffre, en lecture seule. Le terme doit exister
# UNIQUEMENT dans les zones cachées ; le script le vérifie d'abord.
npx tsx src/cli/verifier-dan.ts fuite --coffre <chemin du coffre> --terme <terme>

# find-skill avec de vrais embeddings (10 requêtes de contrôle).
npx tsx src/cli/sync-skills-catalog.ts --out /tmp/apercu-skills
railway run -s obsidian-mcp -- npx tsx src/cli/verifier-dan.ts skills --dossier /tmp/apercu-skills
```
