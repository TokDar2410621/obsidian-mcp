#!/usr/bin/env node
/**
 * Verifications REELLES de Dan, hors tests unitaires (spec du 2026-10-07, §8).
 *
 *   npx tsx packages/app/src/cli/verifier-dan.ts fuite --coffre <chemin> --terme <terme>
 *     Anti-fuite sur un VRAI coffre, en lecture seule (aucun git, aucune
 *     ecriture) : le terme doit exister dans les zones cachees, et Dan ne doit
 *     le rendre nulle part (listing, search-vault, index, search-cerveau,
 *     ask-cerveau). Embeddings factices + BM25 : la fuite se joue sur les
 *     fichiers qui entrent dans l'index, pas sur la qualite des vecteurs.
 *
 *   npx tsx packages/app/src/cli/verifier-dan.ts skills --dossier <apercu> [--requete "debug python"]
 *     find-skill avec de VRAIS embeddings (OPENAI_API_KEY) sur un catalogue
 *     produit par sync-skills-catalog --out.
 *
 * Code de sortie 0 = verification reussie, 1 = echec (detail affiche).
 */

import crypto from 'crypto';
import { promises as fs, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { VaultManager } from '@/services/vault-manager';
import { toVaultRelativePath } from '@/services/vault-manager';
import { VaultInvite } from '@/services/invites/vault-invite';
import { estSensible } from '@/services/securite/zones-sensibles';
import { RagService } from '@/services/rag/rag-service';
import { RagAnswerGenerator } from '@/services/rag/generator';
import { OpenAiEmbeddingProvider } from '@/services/rag/embeddings';
import type { EmbeddingProvider } from '@/services/rag/types';
import { SkillsService } from '@/services/skills/skills-service';
import { handleSearchVault } from '@/mcp/handlers/search-handlers';
import { configureLogger } from '@/utils/logger';

/** Un coffre LOCAL en lecture seule : jamais de git, jamais d'ecriture. */
export class CoffreLocal implements VaultManager {
  constructor(private readonly racine: string) {}
  private complet(rel: string): string {
    return path.join(this.racine, ...toVaultRelativePath(rel).split('/'));
  }
  async readFile(rel: string): Promise<string> {
    return fs.readFile(this.complet(rel), 'utf8');
  }
  async fileExists(rel: string): Promise<boolean> {
    return existsSync(this.complet(rel));
  }
  async listFiles(
    rel = '',
    options: { includeDirectories?: boolean; fileTypes?: string[]; recursive?: boolean } = {},
  ): Promise<string[]> {
    const depart = rel ? this.complet(rel) : this.racine;
    const out: string[] = [];
    const marcher = (d: string): void => {
      for (const e of readdirSync(d)) {
        if (e === '.git' || e === '.obsidian' || e === 'node_modules') continue;
        const p = path.join(d, e);
        const r = path.relative(this.racine, p).split(path.sep).join('/');
        if (statSync(p).isDirectory()) {
          if (options.includeDirectories) out.push(r);
          if (options.recursive !== false) marcher(p);
        } else if (!options.fileTypes?.length || options.fileTypes.includes(e.split('.').pop() ?? '')) {
          out.push(r);
        }
      }
    };
    marcher(depart);
    return out;
  }
  getVaultPath(): string {
    return this.racine;
  }
  async writeFile(): Promise<void> {
    throw new Error('lecture seule');
  }
  async deleteFile(): Promise<void> {
    throw new Error('lecture seule');
  }
  async moveFile(): Promise<void> {
    throw new Error('lecture seule');
  }
  async createDirectory(): Promise<void> {
    throw new Error('lecture seule');
  }
}

class EmbedderSacDeMots implements EmbeddingProvider {
  readonly model = 'sac-de-mots-256';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const v = new Array(256).fill(0);
      for (const mot of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        v[crypto.createHash('md5').update(mot).digest()[0]] += 1;
      }
      v[255] += 0.01;
      return v;
    });
  }
}

function option(args: string[], nom: string): string | undefined {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
}

async function fuite(args: string[]): Promise<number> {
  const coffre = option(args, '--coffre');
  const terme = option(args, '--terme');
  if (!coffre || !terme) throw new Error('--coffre et --terme sont requis');
  process.env.GUEST_MODE = 'true';
  const brut = new CoffreLocal(path.resolve(coffre));
  const dan = new VaultInvite(brut);
  const echecs: string[] = [];

  // 0. Le terme doit exister dans le coffre, et seulement dans les zones cachees.
  const tous = await brut.listFiles('', { recursive: true, fileTypes: ['md'] });
  let dansCache = 0;
  let ailleurs = 0;
  for (const f of tous) {
    const contenu = await brut.readFile(f).catch(() => '');
    if (!contenu.includes(terme)) continue;
    if (estSensible(f)) dansCache++;
    else ailleurs++;
  }
  console.log(`Terme present dans ${dansCache} fichier(s) cache(s), ${ailleurs} visible(s).`);
  if (dansCache === 0) echecs.push("le terme n'existe dans aucune zone cachee : test sans valeur");
  if (ailleurs > 0) echecs.push('le terme existe aussi hors zones cachees : choisir un autre terme');

  // 1. Listing.
  const visibles = await dan.listFiles('', { recursive: true, includeDirectories: true });
  const fuitesListe = visibles.filter(f => estSensible(f));
  console.log(`Listing : ${visibles.length} entrees visibles, ${tous.length - visibles.filter(f => f.endsWith('.md')).length} .md caches.`);
  if (fuitesListe.length) echecs.push(`listing : ${fuitesListe.length} entree(s) cachee(s) visibles`);

  // 2. search-vault exact et approximatif.
  for (const exact of [true, false]) {
    const r = await handleSearchVault(dan, { query: terme, exact, limit: 50 });
    const n = JSON.stringify(r).includes(terme);
    console.log(`search-vault (${exact ? 'exact' : 'approx'}) : ${n ? 'FUITE' : 'rien'}`);
    if (n) echecs.push(`search-vault ${exact ? 'exact' : 'approx'} rend le terme`);
  }

  // 3. Index RAG construit a travers Dan, search-cerveau et ask-cerveau (LLM perroquet).
  const prompts: string[] = [];
  const rag = new RagService({
    reader: {
      listMarkdownFiles: async () => (await dan.listFiles('', { recursive: true, fileTypes: ['md'] })).filter(f => !f.startsWith('09-skills/')),
      readFile: p => dan.readFile(p),
    },
    embedder: new EmbedderSacDeMots(),
    generator: new RagAnswerGenerator({
      model: 'perroquet',
      complete: async (_s: string, u: string) => {
        prompts.push(u);
        return u;
      },
    }),
    indexFile: 'inutile.json',
    persist: false,
    hybrid: true,
    reranker: null,
  });
  await rag.ensureReady();
  const chunks = rag.embeddedChunks;
  const fichiersIndex = new Set(chunks.map(c => c.file));
  const indexCache = [...fichiersIndex].filter(f => estSensible(f));
  const indexTerme = chunks.filter(c => c.text.includes(terme)).length;
  console.log(`Index : ${fichiersIndex.size} notes, ${chunks.length} extraits ; caches : ${indexCache.length} ; extraits avec le terme : ${indexTerme}`);
  if (indexCache.length || indexTerme) echecs.push('index : zone cachee ou terme present');
  const s = await rag.searchCerveau({ query: terme, top_k: 30 });
  const a = await rag.askCerveau({ question: `Que sais-tu de ${terme} ?` });
  const fuiteRecherche = JSON.stringify(s).includes(terme);
  const fuitePrompt = prompts.some(p => p.split('Question :')[0].includes(terme));
  console.log(`search-cerveau : ${fuiteRecherche ? 'FUITE' : 'rien'} ; contexte LLM d'ask-cerveau : ${fuitePrompt ? 'FUITE' : 'propre'}`);
  if (fuiteRecherche) echecs.push('search-cerveau rend le terme');
  if (fuitePrompt) echecs.push("le contexte d'ask-cerveau contient le terme");
  void a;

  if (echecs.length) {
    console.log(`\nECHEC :\n- ${echecs.join('\n- ')}`);
    return 1;
  }
  console.log('\nOK : rien des zones cachees ne sort de Dan sur ce coffre.');
  return 0;
}

async function skills(args: string[]): Promise<number> {
  const dossier = option(args, '--dossier');
  if (!dossier) throw new Error('--dossier est requis');
  const cle = process.env.OPENAI_API_KEY?.trim();
  if (!cle) throw new Error('OPENAI_API_KEY manquant (vrais embeddings exiges)');
  // « debug python » est le critere de la spec ; les autres mesurent la
  // qualite du classement sur des besoins courants (skill attendu).
  const attendus: Record<string, string> = {
    'debug python': 'superpowers-systematic-debugging',
    'write landing page copy': 'marketing-copywriting',
    'plan a multi-step implementation': 'superpowers-writing-plans',
    'test driven development': 'superpowers-test-driven-development',
    'how much should I charge': 'marketing-pricing',
    'seo audit of my site': 'marketing-seo-audit',
    'review my pull request': 'mp-code-review',
    'brainstorm a new feature': 'superpowers-brainstorming',
    'cold email to prospects': 'marketing-cold-email',
    'remove AI writing patterns': 'darius-stop-slop',
  };
  const requetes = option(args, '--requete') ? [option(args, '--requete')!] : Object.keys(attendus);
  const service = new SkillsService({
    vault: new CoffreLocal(path.resolve(dossier)),
    embedder: new OpenAiEmbeddingProvider(cle, process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small'),
    indexFile: 'inutile.json',
    persist: false,
  });
  await service.ensureReady();
  console.log(`Catalogue : ${service.taille} skills indexes avec ${process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small'}`);
  let code = 0;
  let trouves = 0;
  for (const q of requetes) {
    const r = await service.trouver({ query: q, limit: 5 });
    if (!r.success) throw new Error(r.error);
    const top = (r.data as { skills: Array<{ nom: string; score: number }> }).skills;
    const attendu = attendus[q];
    const rang = attendu ? top.findIndex(s => s.nom === attendu) + 1 : 0;
    const verdict = attendu ? ` [attendu ${attendu} : ${rang > 0 ? `rang ${rang}` : 'absent du top 5'}]` : '';
    console.log(`\nfind-skill « ${q} »${verdict}`);
    top.forEach((s, i) => console.log(`  ${i + 1}. ${s.nom} (${s.score})`));
    if (attendu) trouves += rang > 0 ? 1 : 0;
    if (q === 'debug python' && rang === 0) code = 1;
  }
  if (requetes.length > 1) console.log(`\nAttendus dans le top 5 : ${trouves}/${requetes.length}`);
  const lu = await service.lire({ name: 'superpowers-systematic-debugging' });
  const contenu = lu.success ? String((lu.data as { contenu: string }).contenu) : '';
  console.log(`\nread-skill superpowers-systematic-debugging : ${lu.success ? `${contenu.length} caracteres` : lu.error}`);
  if (!lu.success || !contenu.includes('Systematic Debugging')) code = 1;
  console.log(code === 0 ? '\nOK' : '\nECHEC');
  return code;
}

/**
 * Exporte, dans un dossier, EXACTEMENT ce que Dan servirait d'un coffre
 * (zones cachees retirees, donnees personnelles masquees). Sert a auditer
 * le resultat avec un outil independant, avant d'ouvrir Dan.
 */
async function exporter(args: string[]): Promise<number> {
  const coffre = option(args, '--coffre');
  const sortie = option(args, '--sortie');
  if (!coffre || !sortie) throw new Error('--coffre et --sortie sont requis');
  process.env.GUEST_MODE = 'true';
  const dan = new VaultInvite(new CoffreLocal(path.resolve(coffre)));
  const notes = await dan.listFiles('', { recursive: true, fileTypes: ['md'] });
  const contenus = await dan.readManyFiles(notes);
  for (const [rel, contenu] of contenus) {
    const cible = path.join(sortie, ...rel.split('/'));
    await fs.mkdir(path.dirname(cible), { recursive: true });
    await fs.writeFile(cible, contenu, 'utf8');
  }
  console.log(`Export : ${contenus.size} notes servies par Dan`);
  return 0;
}

async function main(): Promise<void> {
  configureLogger({ stream: process.stderr, minLevel: 'error' });
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'exporter') process.exitCode = await exporter(args);
  else if (mode === 'fuite') process.exitCode = await fuite(args);
  else if (mode === 'skills') process.exitCode = await skills(args);
  else {
    console.log('Usage : verifier-dan fuite --coffre <chemin> --terme <terme> | skills --dossier <apercu> [--requete <texte>]');
    process.exitCode = 2;
  }
}

if (process.argv[1] && /verifier-dan\.(ts|js)$/.test(process.argv[1])) {
  main().catch(error => {
    console.error(String((error as Error).message ?? error));
    process.exit(1);
  });
}
