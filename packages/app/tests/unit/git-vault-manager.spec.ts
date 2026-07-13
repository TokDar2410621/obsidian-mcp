import { describe, it, expect, vi, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { stripEmDash, GitVaultManager } from '@/services/git-vault-manager';
import { writeStateFile, type VaultManager } from '@/services/vault-manager';
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
