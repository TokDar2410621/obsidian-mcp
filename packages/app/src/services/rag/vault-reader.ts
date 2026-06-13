import { promises as fs } from 'fs';
import path from 'path';
import type { VaultManager } from '@/services/vault-manager';
import type { VaultReader } from '@/services/rag/types';

/** Folders we never index (templates, generated graphs, app config). */
const EXCLUDED_PREFIXES = ['_templates/', '99-graphify-out/', '.obsidian/', '.git/'];

/**
 * Production reader over a {@link VaultManager}. Lists once through the manager
 * (which syncs the git working copy to remote HEAD), then reads file bodies
 * straight off disk via `getVaultPath()` — NOT through `vault.readFile()`, which
 * would re-sync (git fetch + hard reset) on every single call.
 */
export class GitVaultReader implements VaultReader {
  constructor(private readonly vault: VaultManager) {}

  async listMarkdownFiles(): Promise<string[]> {
    const files = await this.vault.listFiles('', { recursive: true, fileTypes: ['md'] });
    return files.filter(f => !EXCLUDED_PREFIXES.some(prefix => f.startsWith(prefix)));
  }

  async readFile(relativePath: string): Promise<string> {
    return fs.readFile(path.join(this.vault.getVaultPath(), relativePath), 'utf-8');
  }
}
