import { describe, expect, it } from 'vitest';
import { GitVaultManager } from '@/services/git-vault-manager';
import { causeJournalisable } from '@/services/invites/vault-invite';

/** Les deux pannes du premier boot de Dan (2026-10-08). */

describe('GitVaultManager', () => {
  it('nettoie un jeton colle avec un saut de ligne ou des espaces', () => {
    const vm = new GitVaultManager({
      repoUrl: 'https://github.com/x/coffre.git',
      branch: 'main',
      gitToken: '  github_pat_FAUX123\n',
      vaultPath: '/tmp/x',
    });
    expect((vm as any).config.gitToken).toBe('github_pat_FAUX123');
  });
});

describe('causeJournalisable', () => {
  it('garde la cause et masque tout jeton', () => {
    const cause = causeJournalisable(
      new Error(
        "fatal: unable to access 'https://x-access-token:github_pat_ABCDEF123456@github.com/x/coffre.git/': URL rejected",
      ),
    );
    expect(cause).toContain('URL rejected');
    expect(cause).toContain('x-access-token:***@');
    expect(cause).not.toContain('ABCDEF123456');
    expect(causeJournalisable('cle sk-proj-AAAAAAAAAAAAAAAA ghp_BBBBBBBBBBBBBBBB')).toBe('cle *** ***');
  });
});
