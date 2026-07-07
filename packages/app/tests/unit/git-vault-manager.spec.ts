import { describe, it, expect } from 'vitest';
import { stripEmDash } from '@/services/git-vault-manager';

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
