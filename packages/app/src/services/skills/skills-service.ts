import type { VaultManager } from '@/services/vault-manager';
import { readAllFiles } from '@/services/vault-manager';
import { RagService } from '@/services/rag/rag-service';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import type { ToolResponse } from '@/mcp/handlers/types';
import { logger } from '@/utils/logger';

/**
 * Le catalogue de skills du cerveau (spec du 2026-10-07, partie 2).
 *
 * Le catalogue vit dans le coffre, sous `09-skills/<collection>/<skill>.md`,
 * ecrit par scripts/sync-skills-catalog.ts. Il a son PROPRE index semantique :
 * l'index general l'exclut (vault-reader.ts), sinon une centaine de skills
 * tiers noieraient les notes de Darius dans ses propres recherches.
 *
 * find-skill cherche par le sens ; read-skill rend le skill complet.
 */

export const DOSSIER_SKILLS = '09-skills';

/** Une fiche de skill : `09-skills/<collection>/<fichier>.md`, hors `_index`, `LICENSE`. */
const MOTIF_FICHE = /^09-skills\/([^/]+)\/([^/]+)\.md$/;

export interface FicheSkill {
  nom: string;
  collection: string;
  description: string;
  chemin: string;
  references: string[];
}

export interface SkillsServiceOptions {
  vault: VaultManager;
  embedder: EmbeddingProvider;
  indexFile: string;
  persist?: boolean;
}

const LIMITE_DEFAUT = 5;
const LIMITE_MAX = 20;

/** Lit une valeur simple de frontmatter (`cle: valeur` ou `cle: "json"`). */
function valeurFrontmatter(frontmatter: string, cle: string): string | null {
  const ligne = frontmatter.split(/\r?\n/).find(l => l.startsWith(`${cle}:`));
  if (!ligne) return null;
  const brut = ligne.slice(cle.length + 1).trim();
  if (!brut) return null;
  if (brut.startsWith('"')) {
    try {
      return String(JSON.parse(brut));
    } catch {
      return brut.replace(/^"|"$/g, '');
    }
  }
  if (brut.startsWith("'") && brut.endsWith("'")) return brut.slice(1, -1).replace(/''/g, "'");
  return brut;
}

export function decouperFrontmatter(contenu: string): { frontmatter: string; corps: string } {
  const m = contenu.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: '', corps: contenu };
  return { frontmatter: m[1], corps: contenu.slice(m[0].length) };
}

/** Distance d'edition (Levenshtein), pour suggerer les noms proches. */
function distance(a: string, b: string): number {
  const ligne = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = ligne[0];
    ligne[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = ligne[j];
      ligne[j] = Math.min(ligne[j] + 1, ligne[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return ligne[b.length];
}

export function nomsProches(demande: string, noms: string[], n = 3): string[] {
  const d = demande.trim().toLowerCase();
  const mots = d.split(/[^a-z0-9]+/).filter(m => m.length > 2);
  return noms
    .map(nom => {
      const bas = nom.toLowerCase();
      const communs = mots.filter(m => bas.includes(m)).length;
      return { nom, s: distance(d, bas) - communs * 6 - (bas.includes(d) ? 10 : 0) };
    })
    .sort((a, b) => a.s - b.s || a.nom.localeCompare(b.nom))
    .slice(0, n)
    .map(x => x.nom);
}

export class SkillsService implements VaultReader {
  private readonly vault: VaultManager;
  private readonly rag: RagService;
  private fiches = new Map<string, FicheSkill>();
  private contenus = new Map<string, string>();
  private catalogueCharge = false;
  private chargement: Promise<void> | null = null;

  constructor(options: SkillsServiceOptions) {
    this.vault = options.vault;
    this.rag = new RagService({
      reader: this,
      embedder: options.embedder,
      generator: null,
      indexFile: options.indexFile,
      persist: options.persist ?? true,
      hybrid: true,
      reranker: null,
    });
  }

  // --- VaultReader : ce que l'index des skills voit -------------------------

  async listMarkdownFiles(): Promise<string[]> {
    await this.chargerCatalogue();
    return [...this.fiches.keys()];
  }

  async readFile(chemin: string): Promise<string> {
    const fiche = this.fiches.get(chemin);
    const contenu = this.contenus.get(chemin);
    if (!fiche || contenu === undefined) throw new Error(`Skill absent du catalogue : ${chemin}`);
    // Nom et description en tete : ce sont eux qui decrivent QUAND servir le
    // skill, et le chunker ne lit pas le frontmatter.
    const { corps } = decouperFrontmatter(contenu);
    return `# ${fiche.nom}\n\n${fiche.description}\n\n${corps}`;
  }

  // --- catalogue --------------------------------------------------------------

  private async chargerCatalogue(force = false): Promise<void> {
    if (this.catalogueCharge && !force) return;
    if (this.chargement) return this.chargement;
    this.chargement = this.lireCatalogue().finally(() => {
      this.chargement = null;
    });
    return this.chargement;
  }

  private async lireCatalogue(): Promise<void> {
    let tous: string[];
    try {
      tous = await this.vault.listFiles(DOSSIER_SKILLS, { recursive: true, fileTypes: ['md'] });
    } catch {
      tous = []; // pas encore de catalogue dans ce coffre
    }
    const normaliser = (p: string) => p.replace(/\\/g, '/');
    tous = tous.map(normaliser);
    const chemins = tous.filter(p => {
      const m = p.match(MOTIF_FICHE);
      return Boolean(m && !m[2].startsWith('_') && !/^licen[cs]e/i.test(m[2]));
    });
    const contenus = await readAllFiles(this.vault, chemins);

    const fiches = new Map<string, FicheSkill>();
    for (const chemin of chemins) {
      const contenu = contenus.get(chemin);
      if (contenu === undefined) continue;
      const [, collection, fichier] = chemin.match(MOTIF_FICHE)!;
      const { frontmatter } = decouperFrontmatter(contenu);
      const nom = valeurFrontmatter(frontmatter, 'catalogue_nom') ?? `${collection}-${fichier}`;
      const description =
        valeurFrontmatter(frontmatter, 'catalogue_description') ??
        valeurFrontmatter(frontmatter, 'description') ??
        '';
      const dossierRefs = `${DOSSIER_SKILLS}/${collection}/${fichier}/`;
      fiches.set(chemin, {
        nom,
        collection: valeurFrontmatter(frontmatter, 'collection') ?? collection,
        description,
        chemin,
        references: tous.filter(p => p.startsWith(dossierRefs)).sort(),
      });
    }
    this.fiches = fiches;
    this.contenus = new Map([...contenus].filter(([p]) => fiches.has(p)));
    this.catalogueCharge = true;
    logger.info('Catalogue de skills charge', { skills: fiches.size });
  }

  /** Taille du catalogue charge (tests, journaux). */
  get taille(): number {
    return this.fiches.size;
  }

  async ensureReady(): Promise<void> {
    await this.chargerCatalogue();
    await this.rag.ensureReady();
  }

  /** Relit le catalogue et met l'index a jour (seuls les skills modifies sont re-embeddes). */
  async refresh(): Promise<void> {
    await this.chargerCatalogue(true);
    await this.rag.refresh();
  }

  // --- outils -----------------------------------------------------------------

  async trouver(args: { query: string; limit?: number }): Promise<ToolResponse> {
    try {
      await this.ensureReady();
      const limite = Math.min(Math.max(1, Math.floor(args.limit ?? LIMITE_DEFAUT)), LIMITE_MAX);
      const r = await this.rag.searchCerveau({ query: args.query, top_k: 30 });
      if (!r.success) return r;
      const resultats = ((r.data as { results?: Array<{ path: string; score: number }> })?.results ?? []);

      // L'ordre de la recherche hybride fait foi ; le score affiche est le
      // meilleur cosinus des extraits du skill.
      const ordre: string[] = [];
      const meilleur = new Map<string, number>();
      for (const hit of resultats) {
        if (!meilleur.has(hit.path)) ordre.push(hit.path);
        meilleur.set(hit.path, Math.max(meilleur.get(hit.path) ?? -1, hit.score));
      }
      const skills = ordre
        .map(p => this.fiches.get(p))
        .filter((f): f is FicheSkill => Boolean(f))
        .slice(0, limite)
        .map(f => ({
          nom: f.nom,
          description: f.description,
          collection: f.collection,
          score: meilleur.get(f.chemin) ?? 0,
        }));
      return ok({ skills, total: skills.length, catalogue: this.fiches.size });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }

  async lire(args: { name: string }): Promise<ToolResponse> {
    try {
      await this.chargerCatalogue();
      const demande = (args.name ?? '').trim();
      const fiche = [...this.fiches.values()].find(
        f => f.nom.toLowerCase() === demande.toLowerCase(),
      );
      if (!fiche) {
        const proches = nomsProches(demande, [...this.fiches.values()].map(f => f.nom));
        return fail(
          `Skill inconnu : « ${demande} ».` +
            (proches.length ? ` Noms proches : ${proches.join(', ')}.` : '') +
            ' Utilise find-skill pour chercher par le sens.',
        );
      }
      const contenu = await this.vault.readFile(fiche.chemin);
      return ok({
        nom: fiche.nom,
        collection: fiche.collection,
        description: fiche.description,
        chemin: fiche.chemin,
        contenu,
        references: fiche.references,
      });
    } catch (error: any) {
      return fail(error?.message ?? String(error));
    }
  }
}

function ok(data: Record<string, unknown>): ToolResponse {
  return { success: true, data, metadata: { timestamp: new Date().toISOString() } };
}

function fail(error: string): ToolResponse {
  return { success: false, error, metadata: { timestamp: new Date().toISOString() } };
}
