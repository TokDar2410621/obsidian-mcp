import { promises as fs } from 'fs';
import path from 'path';
import type { VaultManager } from '@/services/vault-manager';
import { toVaultRelativePath } from '@/services/vault-manager';
import { estSensible } from '@/services/securite/zones-sensibles';
import type { VaultReader } from '@/services/rag/types';
import { logger } from '@/utils/logger';

/**
 * Le coffre tel que Dan (l'instance invitee) le voit : des NOTES (.md) hors
 * zones cachees, en lecture seule, et tout le reste indiscernable d'un fichier
 * qui n'existe pas.
 *
 * Pourquoi un decorateur plutot qu'une garde par outil. La garde perso
 * (garde-mcp.ts) filtre ce qui SORT des outils, et seulement les tableaux de
 * premier niveau : graph-cerveau, suggest-links et le digest passaient a cote
 * (constat du 2026-10-06). Ici, rien ne sort parce que rien n'entre : le
 * listing ne rend pas ce qui est cache, donc l'index RAG, le graphe et les
 * synapses construits a travers ce coffre ne l'ont jamais vu.
 *
 * Ce qui est cache, en plus des zones sensibles (revue adversariale du
 * 2026-10-07) :
 *   - tout segment qui commence par un point. `.git/config` porte l'URL du
 *     remote AVEC le jeton GitHub : le lire, c'etait cloner tout le coffre,
 *     zones comprises. `.git/index` liste les noms des fichiers caches, et
 *     `.obsidian/` contient des cles de plugins.
 *   - tout ce qui n'est pas une note `.md` : journaux techniques a la racine
 *     (`wa-logs.txt`, `mcp-logs.txt`), etats JSON, PDF. Dan partage un savoir,
 *     pas un systeme de fichiers.
 *   - un lien symbolique dont la cible sort du coffre ou tombe dans ce qui
 *     est cache.
 *
 * Indiscernable veut dire : meme message, au caractere pres, ET meme cout. Un
 * chemin cache paie la meme synchro qu'un chemin absent : sans cela, le temps
 * de reponse dirait quels prefixes sont des zones.
 */

export function messageIntrouvable(chemin: string): string {
  return `Introuvable : « ${chemin} » n'existe pas ou n'est pas accessible.`;
}

export const MESSAGE_LECTURE_SEULE =
  "Dan est en lecture seule : aucune écriture, suppression ni déplacement n'est possible.";

/** Chemin normalise pour les comparaisons : separateurs `/`, Unicode NFC. */
function normaliser(chemin: string): string {
  return (chemin || '').split(path.sep).join('/').replace(/\\/g, '/').normalize('NFC');
}

/** Un dossier ou fichier que Dan ne montre jamais (zone, point, ou hors note). */
export function estCachePourDan(chemin: string): boolean {
  const p = normaliser(chemin);
  const segments = p.split('/').filter(s => s.length > 0 && s !== '.');
  if (segments.some(s => s.startsWith('.'))) return true;
  return estSensible(segments.join('/'));
}

function estNote(chemin: string): boolean {
  return /\.md$/i.test(chemin);
}

export class VaultInvite implements VaultManager {
  constructor(private readonly interne: VaultManager) {}

  /** Note normalisee et visible, ou null (invalide, cachee, ou pas une note). */
  private noteVisible(brut: string): string | null {
    let rel: string;
    try {
      rel = toVaultRelativePath(brut);
    } catch {
      return null;
    }
    return estCachePourDan(rel) || !estNote(rel) ? null : rel;
  }

  /** Dossier normalise et visible, ou null. */
  private dossierVisible(brut: string): string | null {
    let rel: string;
    try {
      rel = toVaultRelativePath(brut);
    } catch {
      return null;
    }
    return estCachePourDan(rel) ? null : rel;
  }

  /**
   * Fait payer a un refus le cout d'une recherche ratee : une vraie synchro
   * suivie d'un test d'existence sur un chemin qui n'existe pas.
   */
  private async attenteNeutre(): Promise<void> {
    await this.interne.fileExists('05-projects/__dan__/absent.md').catch(() => false);
  }

  /**
   * La cible reelle (liens symboliques resolus) reste-t-elle une note visible
   * du coffre ? Coffre virtuel ou fichier absent : rien a resoudre, oui.
   */
  private async cibleSure(rel: string): Promise<boolean> {
    let racine: string;
    let reel: string;
    try {
      racine = await fs.realpath(this.interne.getVaultPath());
      reel = await fs.realpath(path.join(racine, rel));
    } catch {
      return true;
    }
    const relatif = normaliser(path.relative(racine, reel));
    if (!relatif || relatif.startsWith('..') || path.isAbsolute(relatif)) return false;
    return !estCachePourDan(relatif) && estNote(relatif);
  }

  async readFile(relativePath: string): Promise<string> {
    const rel = this.noteVisible(relativePath);
    if (!rel) {
      await this.attenteNeutre();
      throw new Error(messageIntrouvable(relativePath));
    }
    let contenu: string;
    try {
      contenu = await this.interne.readFile(rel);
    } catch (error) {
      logger.debug('Dan : lecture impossible', { error: String(error) });
      throw new Error(messageIntrouvable(relativePath));
    }
    if (!(await this.cibleSure(rel))) {
      logger.warn('Dan : lien symbolique hors perimetre refuse');
      throw new Error(messageIntrouvable(relativePath));
    }
    return contenu;
  }

  async readBinaryFile(relativePath: string): Promise<Buffer> {
    return Buffer.from(await this.readFile(relativePath), 'utf8');
  }

  async readManyFiles(relativePaths: string[]): Promise<Map<string, string>> {
    const visibles = relativePaths
      .map(p => this.noteVisible(p))
      .filter((p): p is string => p !== null);
    let lus: Map<string, string>;
    if (this.interne.readManyFiles) {
      lus = await this.interne.readManyFiles(visibles);
    } else {
      lus = new Map();
      for (const rel of visibles) {
        try {
          lus.set(rel, await this.interne.readFile(rel));
        } catch {
          /* ignore, comme readAllFiles */
        }
      }
    }
    for (const rel of [...lus.keys()]) {
      if (!(await this.cibleSure(rel))) lus.delete(rel);
    }
    return lus;
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const rel = this.noteVisible(relativePath) ?? this.dossierVisible(relativePath);
    if (!rel || (!estNote(rel) && rel.includes('.'))) {
      await this.attenteNeutre();
      return false;
    }
    return this.interne.fileExists(rel);
  }

  async listFiles(
    relativePath?: string,
    options?: { includeDirectories?: boolean; fileTypes?: string[]; recursive?: boolean },
  ): Promise<string[]> {
    let base = '';
    const demande = (relativePath ?? '').trim();
    if (demande && demande !== '.' && demande !== '/') {
      const rel = this.dossierVisible(demande);
      if (!rel) {
        await this.attenteNeutre();
        throw new Error(messageIntrouvable(relativePath ?? ''));
      }
      base = rel;
    }
    let entrees: string[];
    try {
      entrees = await this.interne.listFiles(base, options);
    } catch {
      throw new Error(messageIntrouvable(relativePath ?? ''));
    }
    return entrees
      .map(normaliser)
      .filter(e => !estCachePourDan(e))
      .filter(e => {
        if (estNote(e)) return true;
        // Sans extension : un dossier (n'apparait que si on les demande).
        const dernier = e.split('/').pop() ?? '';
        return Boolean(options?.includeDirectories) && !dernier.includes('.');
      });
  }

  getVaultPath(): string {
    return this.interne.getVaultPath();
  }

  async writeFile(): Promise<void> {
    throw new Error(MESSAGE_LECTURE_SEULE);
  }

  async writeFileLazy(): Promise<void> {
    throw new Error(MESSAGE_LECTURE_SEULE);
  }

  async flushLazy(): Promise<void> {
    /* rien a pousser : Dan n'ecrit jamais */
  }

  async deleteFile(): Promise<void> {
    throw new Error(MESSAGE_LECTURE_SEULE);
  }

  async moveFile(): Promise<void> {
    throw new Error(MESSAGE_LECTURE_SEULE);
  }

  async createDirectory(): Promise<void> {
    throw new Error(MESSAGE_LECTURE_SEULE);
  }

  async remplacerDossier(): Promise<{ ecrits: number; supprimes: number }> {
    throw new Error(MESSAGE_LECTURE_SEULE);
  }
}

/**
 * Le lecteur de l'index de Dan : il lit A TRAVERS VaultInvite (une seule
 * synchro pour tout le coffre via readManyFiles), jamais le disque en direct.
 * GitVaultReader, lui, lit le disque : un lien symbolique ou une regle
 * oubliee y passerait sans controle.
 */
export class LecteurDan implements VaultReader {
  private contenus = new Map<string, string>();

  constructor(
    private readonly vault: VaultInvite,
    private readonly exclure: string[] = ['09-skills/'],
  ) {}

  async listMarkdownFiles(): Promise<string[]> {
    const fichiers = (await this.vault.listFiles('', { recursive: true, fileTypes: ['md'] })).filter(
      f => !this.exclure.some(prefixe => f.startsWith(prefixe)),
    );
    this.contenus = await this.vault.readManyFiles(fichiers);
    return [...this.contenus.keys()];
  }

  async readFile(chemin: string): Promise<string> {
    const contenu = this.contenus.get(chemin);
    if (contenu === undefined) throw new Error(messageIntrouvable(chemin));
    return contenu;
  }
}
