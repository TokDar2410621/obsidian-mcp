import type { VaultManager } from '@/services/vault-manager';
import { toVaultRelativePath } from '@/services/vault-manager';
import { estSensible } from '@/services/securite/zones-sensibles';
import { logger } from '@/utils/logger';

/**
 * Le coffre tel que Dan (l'instance invitee) le voit : lecture seule, zones
 * cachees indiscernables d'un fichier qui n'existe pas.
 *
 * Pourquoi un decorateur plutot qu'une garde par outil. La garde perso
 * (garde-mcp.ts) filtre ce qui SORT des outils, et seulement les tableaux de
 * premier niveau : graph-cerveau, suggest-links et le digest passaient a cote
 * (constat du 2026-10-06). Ici, rien ne sort parce que rien n'entre : le
 * listing ne rend pas les zones cachees, donc l'index RAG, le graphe et les
 * synapses construits a travers ce coffre ne les ont jamais vues.
 *
 * Indiscernable veut dire : meme message, au caractere pres, pour un chemin
 * cache et pour un chemin absent. Un message different (« zone sensible »,
 * un compteur de masques) dirait a l'ami que le fichier existe.
 */

export function messageIntrouvable(chemin: string): string {
  return `Introuvable : « ${chemin} » n'existe pas ou n'est pas accessible.`;
}

export const MESSAGE_LECTURE_SEULE =
  "Dan est en lecture seule : aucune écriture, suppression ni déplacement n'est possible.";

export class VaultInvite implements VaultManager {
  constructor(private readonly interne: VaultManager) {}

  /** Chemin normalise et visible, ou null (invalide ou cache). */
  private visible(brut: string): string | null {
    let rel: string;
    try {
      rel = toVaultRelativePath(brut);
    } catch {
      return null;
    }
    return estSensible(rel) ? null : rel;
  }

  async readFile(relativePath: string): Promise<string> {
    const rel = this.visible(relativePath);
    if (!rel) throw new Error(messageIntrouvable(relativePath));
    try {
      return await this.interne.readFile(rel);
    } catch (error) {
      logger.debug('Dan : lecture impossible', { error: String(error) });
      throw new Error(messageIntrouvable(relativePath));
    }
  }

  async readBinaryFile(relativePath: string): Promise<Buffer> {
    const rel = this.visible(relativePath);
    if (!rel) throw new Error(messageIntrouvable(relativePath));
    try {
      if (this.interne.readBinaryFile) return await this.interne.readBinaryFile(rel);
      return Buffer.from(await this.interne.readFile(rel), 'utf8');
    } catch {
      throw new Error(messageIntrouvable(relativePath));
    }
  }

  async readManyFiles(relativePaths: string[]): Promise<Map<string, string>> {
    const visibles = relativePaths
      .map(p => this.visible(p))
      .filter((p): p is string => p !== null);
    if (this.interne.readManyFiles) return this.interne.readManyFiles(visibles);
    const out = new Map<string, string>();
    for (const rel of visibles) {
      try {
        out.set(rel, await this.interne.readFile(rel));
      } catch {
        /* ignore, comme readAllFiles */
      }
    }
    return out;
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const rel = this.visible(relativePath);
    if (!rel) return false;
    return this.interne.fileExists(rel);
  }

  async listFiles(
    relativePath?: string,
    options?: { includeDirectories?: boolean; fileTypes?: string[]; recursive?: boolean },
  ): Promise<string[]> {
    let base = '';
    if (relativePath && relativePath.trim() && relativePath.trim() !== '.' && relativePath.trim() !== '/') {
      const rel = this.visible(relativePath);
      if (!rel) throw new Error(messageIntrouvable(relativePath));
      base = rel;
    }
    let fichiers: string[];
    try {
      fichiers = await this.interne.listFiles(base, options);
    } catch {
      throw new Error(messageIntrouvable(relativePath ?? ''));
    }
    return fichiers.filter(f => !estSensible(f));
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
}
