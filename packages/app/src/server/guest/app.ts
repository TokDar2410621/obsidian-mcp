import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as auth from '@/services/auth';
import { registerOAuthRoutes } from '@/server/shared/oauth-routes';
import { registerMcpRoute } from '@/server/shared/mcp-routes';
import { instructionsDan } from '@/server/shared/instructions';
import { registerGithubWebhook } from '@/server/local/github-webhook';
import { registerTools } from '@/mcp/tool-registrations';
import { registerRagTools } from '@/mcp/rag-tool-registrations';
import { registerSynapsesTools } from '@/mcp/synapses-tool-registrations';
import { registerGraphTools } from '@/mcp/graph-tool-registrations';
import { registerSkillsTools } from '@/mcp/skills-tool-registrations';
import type { VaultManager } from '@/services/vault-manager';
import { LecteurDan, VaultInvite } from '@/services/invites/vault-invite';
import { redirectionAutoriseeDan } from '@/services/invites/oauth-dan';
import { serveurInvite } from '@/services/invites/serveur-invite';
import type { InviteStore } from '@/services/invites/invite-store';
import { avecAppelant, estJetonLocal } from '@/services/securite/appelant';
import { RagService } from '@/services/rag/rag-service';
import { RagAnswerGenerator } from '@/services/rag/generator';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import type { LlmCompleter } from '@/services/synapses/types';
import { SynapsesService } from '@/services/synapses/synapses-service';
import { GraphService } from '@/services/graph/graph-service';
import { LlmGraph } from '@/services/graph/graph-llm';
import { SkillsService } from '@/services/skills/skills-service';
import { logger } from '@/utils/logger';

/**
 * Dan : l'instance invitee du cerveau (spec du 2026-10-07, partie 1).
 *
 * Construite a part de http.ts, et c'est le point : ce module n'importe AUCUN
 * cron, aucune notif, aucun service qui ecrit. Couper quatorze crons un par un
 * dans http.ts aurait laisse le quinzieme, ajoute demain, tourner chez Dan.
 * Ici, ce qui n'est pas importe ne peut pas demarrer.
 *
 * Tout passe par VaultInvite : outils de fichiers, index RAG, graphe,
 * synapses, catalogue de skills. Les zones cachees n'y entrent jamais.
 */

export interface DependancesDan {
  /** Le coffre brut ; Dan l'enveloppe lui-meme dans VaultInvite. */
  vault: VaultManager;
  invites: InviteStore;
  /** Null : pas de recherche semantique (ni search-cerveau, ni find-skill). */
  embedder: EmbeddingProvider | null;
  /** Null : pas d'ask-cerveau, de synapses ni de graphe. */
  completer: LlmCompleter | null;
  indexDir: string;
  persist?: boolean;
  /** Lecteur de l'index general, construit SUR VaultInvite. Defaut : LecteurDan. */
  lecteur?: (vault: VaultInvite) => VaultReader;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  quotaJour: number;
  nom?: string;
  maintenant?: () => Date;
}

export interface AppDan {
  app: Express;
  mcpServer: McpServer;
  vault: VaultInvite;
  rag: RagService | null;
  graph: GraphService | null;
  synapses: SynapsesService | null;
  skills: SkillsService | null;
  /** Construit les index (pas de cron : ils se rafraichissent au webhook). */
  demarrer(): Promise<void>;
}

/**
 * Authentification de Dan : un token d'ami valide, d'un ami non revoque.
 * Le jeton local (Claude Code, workers) et les tokens de l'instance perso
 * n'ouvrent jamais Dan. La revocation se lit a chaque requete : 401 immediat.
 */
export function authentifierAmi(invites: InviteStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const refuser = (): void => {
      res.status(401).json({
        error: 'invalid_token',
        error_description: 'Access token is invalid, expired or revoked',
      });
    };
    const entete = req.headers.authorization;
    if (!entete?.startsWith('Bearer ')) {
      refuser();
      return;
    }
    const token = entete.substring(7);
    if (estJetonLocal(token)) {
      logger.warn('Dan : jeton local refuse');
      refuser();
      return;
    }
    // Express 4 n'attrape pas le rejet d'un middleware async : une base
    // tombee tuerait le processus. On repond 503, ferme, sans rien ouvrir.
    let invite: Awaited<ReturnType<InviteStore['parId']>>;
    try {
      const donnees = await auth.getValidAccessToken(token);
      if (!donnees?.inviteId) {
        refuser();
        return;
      }
      invite = await invites.parId(donnees.inviteId);
    } catch (error) {
      logger.error('Dan : verification du token impossible', { error: String(error) });
      res.status(503).json({ error: 'temporarily_unavailable' });
      return;
    }
    if (!invite) {
      refuser();
      return;
    }
    avecAppelant(
      { deConfiance: false, origine: 'invite', invite: { id: invite.id, nom: invite.nom } },
      next,
    );
  };
}

export function creerAppDan(deps: DependancesDan): AppDan {
  const nom = deps.nom ?? 'Dan';
  const persist = deps.persist ?? true;
  const vault = new VaultInvite(deps.vault);

  // Les instructions vont dans les OPTIONS (2e argument) : placees dans
  // serverInfo, le SDK les ignore et le client ne les recoit jamais.
  const mcpServer = new McpServer(
    { name: nom, version: '1.0.0' },
    { instructions: instructionsDan(nom) },
  );
  const outils = serveurInvite(mcpServer, {
    invites: deps.invites,
    quotaJour: deps.quotaJour,
    maintenant: deps.maintenant,
  });

  // Les outils de fichiers : la liste blanche ne laisse passer que la lecture.
  registerTools(outils, () => vault);

  const rag = deps.embedder
    ? new RagService({
        reader: deps.lecteur ? deps.lecteur(vault) : new LecteurDan(vault),
        embedder: deps.embedder,
        generator: deps.completer ? new RagAnswerGenerator(deps.completer) : null,
        // Nom distinct de l'index perso : un index perso copie par erreur dans
        // ce volume ne serait jamais charge.
        indexFile: path.join(deps.indexDir, 'dan-index.json'),
        persist,
        hybrid: true,
        reranker: null, // spec §1.7 : pas de reclassement LLM chez Dan
      })
    : null;
  if (rag) registerRagTools(outils, rag);

  const synapses = rag && deps.completer ? new SynapsesService({ rag, llm: deps.completer }) : null;
  if (synapses) registerSynapsesTools(outils, synapses);

  const graph =
    rag && deps.completer
      ? new GraphService({
          rag,
          llm: new LlmGraph(deps.completer),
          graphFile: path.join(deps.indexDir, 'dan-graph.json'),
          persist,
        })
      : null;
  if (graph) registerGraphTools(outils, graph);

  const skills = deps.embedder
    ? new SkillsService({
        vault,
        embedder: deps.embedder,
        indexFile: path.join(deps.indexDir, 'dan-skills-index.json'),
        persist,
      })
    : null;
  if (skills) registerSkillsTools(outils, skills);

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
  app.use(express.urlencoded({ extended: true }));

  registerOAuthRoutes(app, {
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    baseUrl: deps.baseUrl,
    verifierConnexion: async secret => {
      const invite = await deps.invites.parSecret(secret);
      return invite ? { inviteId: invite.id } : null;
    },
    accepterRafraichissement: async inviteId =>
      Boolean(inviteId && (await deps.invites.parId(inviteId))),
    pageConnexion: {
      titre: nom,
      sousTitre: "L'IA de Darius, en lecture seule",
      libelle: "Ton code d'accès",
      placeholder: "Colle le code que Darius t'a donné",
      bouton: 'Entrer',
      aide: 'Ce code est personnel : ne le partage pas. Darius peut le révoquer à tout moment.',
      erreurVide: "Colle ton code d'accès.",
      erreurInvalide: 'Code invalide ou révoqué.',
    },
    redirectionAutorisee: uri => redirectionAutoriseeDan(uri),
    pkceS256Seulement: true,
  });

  registerMcpRoute(app, mcpServer, authentifierAmi(deps.invites));

  if (rag) {
    // Fraicheur seulement : ni echos (vault null), ni sweeps, ni reflexion.
    registerGithubWebhook(app, rag, graph, null, null, {
      vault: null,
      reflection: null,
      rafraichirEnPlus: skills ? () => skills.refresh() : null,
    });
  }

  return {
    app,
    mcpServer,
    vault,
    rag,
    graph,
    synapses,
    skills,
    async demarrer() {
      logger.info(`${nom} : aucun cron (instance invitee, lecture seule)`);
      if (rag) {
        // Toujours une reindexation au boot, meme avec un index persiste : une
        // note deplacee en zone cachee ou une zone ajoutee pendant que Dan
        // dormait ne doit pas survivre dans l'ancien index (revue du
        // 2026-10-07). Les embeddings inchanges sont reutilises par empreinte.
        await rag.ensureReady();
        await rag.refresh();
        logger.info(`${nom} : index pret`);
      }
      if (skills) {
        await skills.ensureReady();
        await skills.refresh();
        logger.info(`${nom} : catalogue de skills pret`, { skills: skills.taille });
      }
      if (graph) {
        await graph
          .build()
          .then(g => logger.info(`${nom} : graphe pret`, { ...g }))
          .catch(error => logger.error(`${nom} : graphe en echec`, { error: String(error) }));
      }
    },
  };
}
