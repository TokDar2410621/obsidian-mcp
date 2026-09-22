import { describe, it, expect, vi, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { stripEmDash, GitVaultManager } from '@/services/git-vault-manager';
import {
  readBinary,
  writeStateFile,
  toVaultRelativePath,
  type VaultManager,
} from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

describe('stripEmDash (zero em-dash teeth at the server write path)', () => {
  it('replaces a spaced em-dash with a colon in markdown', () => {
    expect(stripEmDash('03-daily/x.md', 'Railway — obsidian-mcp')).toBe('Railway : obsidian-mcp');
  });

  it('replaces a tight em-dash and collapses surrounding spaces', () => {
    expect(stripEmDash('a.md', 'au-delà—flat')).toBe('au-delà : flat');
    expect(stripEmDash('a.md', 'a   —   b')).toBe('a : b');
  });

  it('handles several em-dashes on one line', () => {
    expect(stripEmDash('a.md', 'a — b — c')).toBe('a : b : c');
  });

  it('never crosses a newline (keeps structure)', () => {
    expect(stripEmDash('a.md', 'line —\nnext')).toBe('line : \nnext');
  });

  it('leaves content without em-dash untouched', () => {
    expect(stripEmDash('a.md', 'rien a changer : ici')).toBe('rien a changer : ici');
  });

  it('only touches markdown files, not json/state', () => {
    expect(stripEmDash('08-auto/_brief-state.json', '{"x":"a—b"}')).toBe('{"x":"a—b"}');
  });
});

// --- écritures d'état groupées (la fin de la tempête de commits) ---------------

function vaultLazy(): { vm: GitVaultManager; commits: ReturnType<typeof vi.fn>; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-lazy-'));
  const vm = new GitVaultManager({
    repoUrl: 'https://example.invalid/repo.git',
    branch: 'main',
    gitToken: 'x',
    vaultPath: dir,
  });
  // On teste la mécanique lazy, pas git : sync et commit sont neutralisés.
  const commits = vi.fn(async () => undefined);
  (vm as any).initialize = async () => undefined;
  (vm as any).commitAndPush = commits;
  return { vm, commits, dir };
}

describe('GitVaultManager : écritures d état groupées (writeFileLazy)', () => {
  it('readFile sert le contenu en attente avant même le flush', async () => {
    const { vm } = vaultLazy();
    await vm.writeFileLazy('08-auto/_objectifs-sweep.json', '{"v":1}');
    expect(await vm.readFile('08-auto/_objectifs-sweep.json')).toBe('{"v":1}');
  });

  it('N écritures lazy = UN seul commit au flush, fichiers bien sur disque', async () => {
    const { vm, commits, dir } = vaultLazy();
    await vm.writeFileLazy('08-auto/_echos.md', '# echos');
    await vm.writeFileLazy('08-auto/_objectifs-sweep.json', '{"v":2}');
    await vm.writeFileLazy('08-auto/_relances-state.json', '{"asked":{}}');
    expect(commits).not.toHaveBeenCalled();

    await vm.flushLazy();

    expect(commits).toHaveBeenCalledTimes(1);
    const [message, files] = commits.mock.calls[0] as unknown as [string, string[]];
    expect(message).toContain('3 fichier(s) (batch)');
    expect(files).toHaveLength(3);
    expect(await fsReadFile(path.join(dir, '08-auto/_echos.md'), 'utf-8')).toBe('# echos');
    // Un second flush sans rien en attente ne committe pas.
    await vm.flushLazy();
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('la dernière écriture lazy du même fichier gagne, et l em-dash est assaini', async () => {
    const { vm } = vaultLazy();
    await vm.writeFileLazy('08-auto/_echos.md', 'v1');
    await vm.writeFileLazy('08-auto/_echos.md', 'v2 — avec tiret');
    expect(await vm.readFile('08-auto/_echos.md')).toBe('v2 : avec tiret');
  });

  it('un échec de commit réinjecte l état en attente (rien n est perdu)', async () => {
    const { vm, commits } = vaultLazy();
    commits.mockRejectedValueOnce(new Error('push race'));
    await vm.writeFileLazy('08-auto/_echos.md', 'precieux');
    await expect(vm.flushLazy()).rejects.toThrow('push race');
    // L état attend le prochain flush.
    expect(await vm.readFile('08-auto/_echos.md')).toBe('precieux');
    await vm.flushLazy();
    expect(commits).toHaveBeenCalledTimes(2);
  });

  it('writeStateFile retombe sur writeFile quand le vault ne sait pas faire lazy', async () => {
    const writes: string[] = [];
    const fake = {
      writeFile: async (p: string) => void writes.push(p),
    } as unknown as VaultManager;
    await writeStateFile(fake, '08-auto/x.json', '{}');
    expect(writes).toEqual(['08-auto/x.json']);
  });
});

// --- garde-fou des chemins (incident 2026-08-04 : fichier C:\Users\... commite,
// --- checkout Windows casse, push PC2 en panne) --------------------------------

// Le chemin EXACT qui a empoisonne le vault le 2026-08-04.
const POISON =
  'C:\\Users\\Darius\\AppData\\Roaming\\Claude\\local-agent-mode-sessions' +
  '\\fea34128-592a-4437-a799-72a93c4f56bc\\9f51343a-0d28-4a43-bcf9-05c69155e00f' +
  '\\spaces\\ebe8d3ae-1d97-4479-8d21-3330c29764e5\\memory\\MEMORY.md';

describe('toVaultRelativePath (chemins imcheckoutables sous Windows refuses)', () => {
  it('accepte et conserve un chemin vault normal', () => {
    expect(toVaultRelativePath('05-projects/cerveau/note.md')).toBe('05-projects/cerveau/note.md');
    expect(toVaultRelativePath('03-daily/2026-08-05.md')).toBe('03-daily/2026-08-05.md');
    expect(toVaultRelativePath('note avec espaces et accents é.md')).toBe(
      'note avec espaces et accents é.md',
    );
  });

  it('normalise les backslashes RELATIFS en slashes (entree Windows innocente)', () => {
    expect(toVaultRelativePath('05-projects\\cerveau\\note.md')).toBe('05-projects/cerveau/note.md');
  });

  it("refuse le chemin exact de l'incident du 2026-08-04", () => {
    expect(() => toVaultRelativePath(POISON)).toThrow(/absolu/i);
  });

  it('refuse les chemins absolus unix et ~', () => {
    expect(() => toVaultRelativePath('/etc/passwd')).toThrow(/absolu/i);
    expect(() => toVaultRelativePath('~/notes/x.md')).toThrow(/absolu/i);
  });

  it('refuse la traversee ..', () => {
    expect(() => toVaultRelativePath('../hors-vault.md')).toThrow(/\.\./);
    expect(() => toVaultRelativePath('05-projects/../../hors.md')).toThrow(/\.\./);
  });

  it('refuse ":" (lecteur ou flux NTFS) et les caracteres interdits Windows', () => {
    expect(() => toVaultRelativePath('note.md:stream')).toThrow(/:/);
    expect(() => toVaultRelativePath('a<b.md')).toThrow(/interdit/);
    expect(() => toVaultRelativePath('a|b.md')).toThrow(/interdit/);
  });

  it('refuse les noms reserves Windows et les fins de segment en point/espace', () => {
    expect(() => toVaultRelativePath('CON.md')).toThrow(/reserve/i);
    expect(() => toVaultRelativePath('x/nul/note.md')).toThrow(/reserve/i);
    expect(() => toVaultRelativePath('dossier./note.md')).toThrow(/point ou un/);
    expect(() => toVaultRelativePath('note.md ')).not.toThrow(); // trim des extremites
    expect(() => toVaultRelativePath('a /b.md')).toThrow(/point ou un/);
  });

  it('refuse le vide et nettoie les segments . et //', () => {
    expect(() => toVaultRelativePath('')).toThrow(/vide/i);
    expect(toVaultRelativePath('./05-projects//x.md')).toBe('05-projects/x.md');
  });
});

describe('GitVaultManager : le garde-fou est cable a chaque entree', () => {
  it("writeFile refuse le chemin de l'incident (plus jamais de C:\\ commite)", async () => {
    const { vm, commits } = vaultLazy();
    await expect(vm.writeFile(POISON, 'peu importe')).rejects.toThrow(/absolu/i);
    expect(commits).not.toHaveBeenCalled();
  });

  it('writeFileLazy refuse pareil (le chemin de l incident venait d une ecriture d etat)', async () => {
    const { vm } = vaultLazy();
    await expect(vm.writeFileLazy(POISON, 'x')).rejects.toThrow(/absolu/i);
  });

  it('moveFile valide la source ET la destination', async () => {
    const { vm } = vaultLazy();
    await expect(vm.moveFile('a.md', POISON)).rejects.toThrow(/absolu/i);
    await expect(vm.moveFile(POISON, 'a.md')).rejects.toThrow(/absolu/i);
  });

  it('readFile refuse la traversee hors vault', async () => {
    const { vm } = vaultLazy();
    await expect(vm.readFile('../../secrets.txt')).rejects.toThrow(/\.\./);
  });

  it('une ecriture backslash-relative aboutit au meme fichier que la version slash', async () => {
    const { vm } = vaultLazy();
    await vm.writeFileLazy('08-auto\\_test-backslash.json', '{"ok":1}');
    expect(await vm.readFile('08-auto/_test-backslash.json')).toBe('{"ok":1}');
  });
});

// --- lecture BINAIRE : une image doit sortir du coffre intacte ----------------

describe('GitVaultManager : readBinaryFile', () => {
  it('46. rend les octets EXACTS d un PNG, sans corruption utf8', async () => {
    // Le passage par une chaine utf8 remplace tout octet non decodable par
    // U+FFFD : l en-tete 89 50 4E 47 ne survivrait pas, et le telephone
    // afficherait une image cassee.
    const { vm, dir } = vaultLazy();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x7f]);
    await fsWriteFile(path.join(dir, 'hero.png'), png);

    const lus = await vm.readBinaryFile('hero.png');
    expect(lus.equals(png)).toBe(true);
    expect(lus.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('sert une ecriture lazy en attente, comme readFile', async () => {
    const { vm } = vaultLazy();
    await vm.writeFileLazy('08-auto/_livraison-state.json', '{"version":1}');
    expect((await vm.readBinaryFile('08-auto/_livraison-state.json')).toString('utf8')).toBe(
      '{"version":1}',
    );
  });

  it('refuse un chemin absolu, comme tout le reste du coffre', async () => {
    const { vm } = vaultLazy();
    await expect(vm.readBinaryFile('C:\\Users\\leroi\\note.md')).rejects.toThrow();
  });
});

describe('readBinary : le repli des doubles de test', () => {
  it('47. sans readBinaryFile, retombe sur un Buffer utf8 de readFile', async () => {
    // C est ce qui garde readBinaryFile OPTIONNELLE : onze classes implementent
    // VaultManager, dont neuf FakeVault dans tests/unit.
    const sansBinaire = {
      readFile: async () => 'contenu du coffre',
    } as unknown as VaultManager;
    const lu = await readBinary(sansBinaire, 'a/b.md');
    expect(Buffer.isBuffer(lu)).toBe(true);
    expect(lu.toString('utf8')).toBe('contenu du coffre');
  });

  it('utilise readBinaryFile quand le coffre sait le faire', async () => {
    const octets = Buffer.from([0x00, 0xff, 0x10]);
    const avecBinaire = {
      readFile: async () => 'jamais appele',
      readBinaryFile: async () => octets,
    } as unknown as VaultManager;
    expect((await readBinary(avecBinaire, 'a/b.png')).equals(octets)).toBe(true);
  });
});
