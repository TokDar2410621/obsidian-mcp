export interface VaultManager {
  /**
   * Optional: lazy INTERNAL-STATE write (batched into one commit every few
   * minutes). Implemented by GitVaultManager; fakes fall back to writeFile
   * via the {@link writeStateFile} helper.
   */
  writeFileLazy?(relativePath: string, content: string): Promise<void>;
  /** Optional: flush pending lazy writes now (shutdown, tests). */
  flushLazy?(): Promise<void>;
  /**
   * Optional: bulk read (ONE sync then plain disk reads). Implemented by
   * GitVaultManager; fakes fall back to per-file readFile via
   * {@link readAllFiles}. Unreadable files are silently skipped.
   */
  readManyFiles?(relativePaths: string[]): Promise<Map<string, string>>;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  moveFile(sourcePath: string, destPath: string): Promise<void>;
  createDirectory(relativePath: string, recursive: boolean): Promise<void>;
  listFiles(
    relativePath?: string,
    options?: {
      includeDirectories?: boolean;
      fileTypes?: string[];
      recursive?: boolean;
    },
  ): Promise<string[]>;
  fileExists(relativePath: string): Promise<boolean>;
  getVaultPath(): string;
}


/**
 * Write an internal-state artifact (sweep state, echoes, journal) lazily when
 * the vault supports it, eagerly otherwise. State files nobody waits on must
 * never cost one commit+push each: that storm (79/141 daily commits measured
 * on 2026-07-12) made the PC2 workers lose their push races three days in a row.
 */
export function writeStateFile(
  vault: VaultManager,
  relativePath: string,
  content: string,
): Promise<void> {
  if (vault.writeFileLazy) return vault.writeFileLazy(relativePath, content);
  return vault.writeFile(relativePath, content);
}


/**
 * Bulk read with graceful fallback: one exclusive sync when the vault supports
 * it, per-file reads otherwise (fakes, tests). Unreadable files are skipped.
 */
export async function readAllFiles(
  vault: VaultManager,
  relativePaths: string[],
): Promise<Map<string, string>> {
  if (vault.readManyFiles) return vault.readManyFiles(relativePaths);
  const out = new Map<string, string>();
  for (const rel of relativePaths) {
    try {
      out.set(rel, await vault.readFile(rel));
    } catch {
      /* skipped */
    }
  }
  return out;
}
