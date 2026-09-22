/**
 * Garde-fou des chemins relatifs du vault (incident 2026-08-04) : une session
 * Claude de PC1 a ecrit sa memoire via le MCP avec un chemin ABSOLU Windows ;
 * le serveur (Linux, ou `\` et `:` sont des caracteres de nom legaux) a cree
 * un fichier litteralement nomme `C:\Users\...\MEMORY.md` et l'a commite.
 * Consequence : plus AUCUN clone Windows ne pouvait faire de checkout
 * (`error: invalid path`), push PC2 en panne jusqu'au retrait chirurgical du
 * fichier via l'API GitHub. Ce validateur est la ceinture cote serveur :
 * backslashes normalises en `/`, puis REFUS de tout chemin absolu, traversant
 * (`..`), ou imcheckoutable sous Windows (`:`, `< > " | ? *`, caracteres de
 * controle, noms reserves CON/NUL/COM1..., segment finissant par point ou
 * espace). Retourne le chemin normalise, a utiliser pour toute la suite.
 */
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WINDOWS_INVALID_CHARS = /[<>"|?*\u0000-\u001f]/;

export function toVaultRelativePath(rawPath: string): string {
  const raw = (rawPath ?? '').trim();
  if (!raw) {
    throw new Error(
      'Chemin vide : donne un chemin RELATIF au vault, ex. "05-projects/x/note.md".',
    );
  }
  const slashed = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(slashed) || slashed.startsWith('/') || slashed.startsWith('~')) {
    throw new Error(
      `Chemin refuse (${rawPath}) : chemin ABSOLU ou hors vault. Donne un chemin ` +
        'RELATIF au vault, ex. "05-projects/x/note.md". Les chemins machine ' +
        '(C:\\Users\\..., /home/..., ~/...) creent des fichiers imcheckoutables ' +
        'sur Windows (panne push PC2 du 2026-08-04).',
    );
  }
  if (slashed.includes(':')) {
    throw new Error(
      `Chemin refuse (${rawPath}) : ":" est interdit dans un nom de fichier ` +
        'Windows (lecteur ou flux NTFS).',
    );
  }
  if (WINDOWS_INVALID_CHARS.test(slashed)) {
    throw new Error(
      `Chemin refuse (${rawPath}) : caractere interdit sous Windows ` +
        '(< > " | ? * ou caractere de controle).',
    );
  }
  const segments = slashed.split('/').filter(s => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    throw new Error(`Chemin refuse (${rawPath}) : aucun segment utilisable.`);
  }
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(
        `Chemin refuse (${rawPath}) : ".." (sortie du vault) est interdit.`,
      );
    }
    if (/[. ]$/.test(seg)) {
      throw new Error(
        `Chemin refuse (${rawPath}) : un segment finit par un point ou un ` +
          'espace, imcheckoutable sous Windows.',
      );
    }
    if (WINDOWS_RESERVED_BASENAME.test(seg.split('.')[0])) {
      throw new Error(
        `Chemin refuse (${rawPath}) : "${seg}" est un nom reserve Windows ` +
          '(CON, NUL, COM1, ...).',
      );
    }
  }
  return segments.join('/');
}

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
  /**
   * Optional: RAW BYTES (images, PDF). Implemented by GitVaultManager; fakes
   * fall back to a utf8 Buffer of readFile via {@link readBinary}.
   *
   * Optional on purpose: eleven classes implement VaultManager (the git one,
   * the in-memory double, and nine FakeVault under tests/unit). A REQUIRED
   * method would break `tsc --noEmit` in ten files, exactly like
   * readManyFiles? and writeFileLazy? before it.
   */
  readBinaryFile?(relativePath: string): Promise<Buffer>;
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
 * Read raw bytes with graceful fallback. Real vaults read the file as-is (a
 * PNG stays a PNG); fakes return a utf8 Buffer of their text content, which is
 * enough for every test double and keeps the interface method optional.
 *
 * Never read the disk directly instead of this: GitVaultManager serializes its
 * reads behind the same lock as `git reset --hard`, and a raw fs.readFile on
 * the vault path would happily serve a half-synced file.
 */
export async function readBinary(
  vault: VaultManager,
  relativePath: string,
): Promise<Buffer> {
  if (vault.readBinaryFile) return vault.readBinaryFile(relativePath);
  return Buffer.from(await vault.readFile(relativePath), 'utf8');
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
