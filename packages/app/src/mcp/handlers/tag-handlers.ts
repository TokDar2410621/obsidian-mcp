import { promises as fs } from 'fs';
import path from 'path';
import { VaultManager } from '@/services/vault-manager';
import type { ToolResponse } from './types';

/**
 * Read a note body straight off the synced working copy (one disk read), instead
 * of `vault.readFile()` which re-runs a full git sync (fetch + hard reset) per
 * call. Vault-wide scans (manage-tags / rename-tag) call this after a single
 * `listFiles()` sync — turning N git syncs into one and curing the timeouts.
 */
async function readBody(vault: VaultManager, relativePath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(vault.getVaultPath(), relativePath), 'utf-8');
  } catch {
    // Fallback for vault managers whose working copy isn't on disk (e.g. the
    // in-memory test double). Production GitVaultManager always hits the fast path.
    return vault.readFile(relativePath);
  }
}

export async function handleAddTags(
  vault: VaultManager,
  args: {
    path: string;
    tags: string[];
    location?: 'frontmatter' | 'inline' | 'both';
    deduplicate?: boolean;
  },
): Promise<ToolResponse> {
  try {
    const location = args.location || 'frontmatter';
    const deduplicate = args.deduplicate !== false;
    const content = await vault.readFile(args.path);

    let newContent = content;
    const tagsAdded: string[] = [];

    if (location === 'frontmatter' || location === 'both') {
      newContent = addTagsToFrontmatter(newContent, args.tags, deduplicate);
      tagsAdded.push(...args.tags);
    }

    if (location === 'inline' || location === 'both') {
      const inlineResult = addInlineTags(newContent, args.tags, deduplicate);
      newContent = inlineResult.content;
      tagsAdded.push(...inlineResult.added);
    }

    await vault.writeFile(args.path, newContent);

    return {
      success: true,
      data: {
        success: true,
        path: args.path,
        tags_added: deduplicate ? [...new Set(tagsAdded)] : tagsAdded,
      },
      metadata: {
        timestamp: new Date().toISOString(),
        affected_files: [args.path],
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      metadata: { timestamp: new Date().toISOString() },
    };
  }
}

export async function handleRemoveTags(
  vault: VaultManager,
  args: {
    path: string;
    tags: string[];
    location?: 'frontmatter' | 'inline' | 'both';
  },
): Promise<ToolResponse> {
  try {
    const location = args.location || 'both';
    const content = await vault.readFile(args.path);

    let newContent = content;

    if (location === 'frontmatter' || location === 'both') {
      newContent = removeTagsFromFrontmatter(newContent, args.tags);
    }

    if (location === 'inline' || location === 'both') {
      newContent = removeInlineTags(newContent, args.tags);
    }

    await vault.writeFile(args.path, newContent);

    return {
      success: true,
      data: {
        success: true,
        path: args.path,
        tags_removed: args.tags,
      },
      metadata: {
        timestamp: new Date().toISOString(),
        affected_files: [args.path],
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      metadata: { timestamp: new Date().toISOString() },
    };
  }
}

export async function handleRenameTag(
  vault: VaultManager,
  args: {
    old_tag: string;
    new_tag: string;
    case_sensitive?: boolean;
    dry_run?: boolean;
  },
): Promise<ToolResponse> {
  try {
    const caseSensitive = args.case_sensitive || false;
    const dryRun = args.dry_run || false;

    const allFiles = await vault.listFiles('', {
      fileTypes: ['md'],
      recursive: true,
    });

    const filesAffected: string[] = [];
    let totalReplacements = 0;

    const inlineRe = () =>
      new RegExp(`#${escapeRegExp(args.old_tag)}\\b`, caseSensitive ? 'g' : 'gi');

    for (const filePath of allFiles) {
      const content = await readBody(vault, filePath);

      // Inline tags (#tag).
      const inlineMatches = content.match(inlineRe());
      let newContent = inlineMatches ? content.replace(inlineRe(), `#${args.new_tag}`) : content;
      let count = inlineMatches?.length || 0;

      // Frontmatter tags (tags: [a, b] or a YAML block list).
      const fm = renameFrontmatterTag(newContent, args.old_tag, args.new_tag, caseSensitive);
      newContent = fm.content;
      count += fm.count;

      if (count > 0) {
        filesAffected.push(filePath);
        totalReplacements += count;

        if (!dryRun) {
          await vault.writeFile(filePath, newContent);
        }
      }
    }

    return {
      success: true,
      data: {
        success: true,
        files_affected: filesAffected,
        total_replacements: totalReplacements,
        dry_run: dryRun,
      },
      metadata: {
        timestamp: new Date().toISOString(),
        affected_files: dryRun ? undefined : filesAffected,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      metadata: { timestamp: new Date().toISOString() },
    };
  }
}

export async function handleManageTags(
  vault: VaultManager,
  args: {
    action: 'list' | 'count' | 'merge';
    tag?: string;
    merge_into?: string;
    sort_by?: 'name' | 'count';
    include_nested?: boolean;
  },
): Promise<ToolResponse> {
  try {
    const allFiles = await vault.listFiles('', {
      fileTypes: ['md'],
      recursive: true,
    });

    const tagCounts = new Map<string, Set<string>>();

    for (const filePath of allFiles) {
      const content = await readBody(vault, filePath);

      // Union of inline (#tag) and frontmatter (tags: [...]) tags, deduped per file.
      const fileTags = new Set<string>();
      for (const match of content.matchAll(/#([\w/-]+)/g)) fileTags.add(match[1]);
      for (const tag of extractFrontmatterTags(content)) fileTags.add(tag);

      for (const tag of fileTags) {
        if (!tagCounts.has(tag)) {
          tagCounts.set(tag, new Set());
        }
        tagCounts.get(tag)!.add(filePath);
      }
    }

    if (args.action === 'list' || args.action === 'count') {
      const tags = Array.from(tagCounts.entries()).map(([tag, files]) => ({
        tag,
        count: files.size,
        files: args.action === 'list' ? Array.from(files) : undefined,
      }));

      if (args.sort_by === 'count') {
        tags.sort((a, b) => b.count - a.count);
      } else {
        tags.sort((a, b) => a.tag.localeCompare(b.tag));
      }

      return {
        success: true,
        data: {
          action: args.action,
          tags,
          total_tags: tags.length,
        },
        metadata: { timestamp: new Date().toISOString() },
      };
    } else if (args.action === 'merge') {
      if (!args.tag || !args.merge_into) {
        throw new Error('merge action requires both tag and merge_into parameters');
      }

      const renameResult = await handleRenameTag(vault, {
        old_tag: args.tag,
        new_tag: args.merge_into,
        dry_run: false,
      });

      return {
        success: renameResult.success,
        data: {
          action: 'merge',
          merged: {
            from: args.tag,
            into: args.merge_into,
            files_affected: renameResult.data?.files_affected.length || 0,
          },
        },
        metadata: renameResult.metadata,
      };
    }

    throw new Error(`Unknown action: ${args.action}`);
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      metadata: { timestamp: new Date().toISOString() },
    };
  }
}

function addTagsToFrontmatter(content: string, tags: string[], deduplicate: boolean): string {
  const lines = content.split('\n');
  let frontmatterEnd = -1;

  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        frontmatterEnd = i;
        break;
      }
    }
  }

  if (frontmatterEnd === -1) {
    const tagLine = `tags: [${tags.join(', ')}]`;
    lines.unshift('---', tagLine, '---', '');
  } else {
    let tagsLineIndex = -1;
    for (let i = 1; i < frontmatterEnd; i++) {
      if (lines[i].trim().startsWith('tags:')) {
        tagsLineIndex = i;
        break;
      }
    }

    if (tagsLineIndex === -1) {
      lines.splice(frontmatterEnd, 0, `tags: [${tags.join(', ')}]`);
    } else {
      const existingTags = parseTagsFromLine(lines[tagsLineIndex]);
      const allTags = deduplicate
        ? [...new Set([...existingTags, ...tags])]
        : [...existingTags, ...tags];
      lines[tagsLineIndex] = `tags: [${allTags.join(', ')}]`;
    }
  }

  return lines.join('\n');
}

function removeTagsFromFrontmatter(content: string, tags: string[]): string {
  const lines = content.split('\n');
  let frontmatterEnd = -1;

  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        frontmatterEnd = i;
        break;
      }
    }
  }

  if (frontmatterEnd !== -1) {
    for (let i = 1; i < frontmatterEnd; i++) {
      if (lines[i].trim().startsWith('tags:')) {
        const existingTags = parseTagsFromLine(lines[i]);
        const remainingTags = existingTags.filter(t => !tags.includes(t));
        lines[i] = `tags: [${remainingTags.join(', ')}]`;
        break;
      }
    }
  }

  return lines.join('\n');
}

function addInlineTags(
  content: string,
  tags: string[],
  deduplicate: boolean,
): { content: string; added: string[] } {
  const existing = deduplicate
    ? new Set((content.match(/#([\w/-]+)/g) || []).map(tag => tag.slice(1)))
    : null;

  const tagsToAdd = deduplicate && existing ? tags.filter(tag => !existing.has(tag)) : [...tags];

  if (tagsToAdd.length === 0) {
    return { content, added: [] };
  }

  const lines = content.split('\n');

  let targetLineIndex = -1;
  let afterFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && lines[i] === '---') {
      afterFrontmatter = false;
      continue;
    }
    if (!afterFrontmatter && lines[i] === '---') {
      afterFrontmatter = true;
      continue;
    }
    if (!afterFrontmatter) continue;

    if (lines[i].includes('#')) {
      targetLineIndex = i;
      break;
    }
  }

  if (targetLineIndex >= 0) {
    lines[targetLineIndex] += ' ' + tagsToAdd.map(t => `#${t}`).join(' ');
  } else {
    const separator = content.endsWith('\n') ? '' : '\n';
    return {
      content: content + separator + tagsToAdd.map(t => `#${t}`).join(' '),
      added: tagsToAdd,
    };
  }

  return {
    content: lines.join('\n'),
    added: tagsToAdd,
  };
}

function removeInlineTags(content: string, tags: string[]): string {
  let result = content;
  for (const tag of tags) {
    result = result.replace(new RegExp(`#${escapeRegExp(tag)}\\b`, 'g'), '');
  }
  return result;
}

function parseTagsFromLine(line: string): string[] {
  const match = line.match(/tags:\s*\[(.*)\]/);
  if (!match) return [];

  return match[1]
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/** Tags declared in YAML frontmatter (`tags: [a, b]`, `tags: a, b`, or a `- item` block list). */
function extractFrontmatterTags(content: string): string[] {
  const lines = content.split('\n');
  if (lines[0] !== '---') return [];

  let frontmatterEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      frontmatterEnd = i;
      break;
    }
  }
  if (frontmatterEnd === -1) return [];

  const tags: string[] = [];
  for (let i = 1; i < frontmatterEnd; i++) {
    const match = lines[i].match(/^\s*tags:\s*(.*)$/);
    if (!match) continue;

    const rest = match[1].trim();
    if (rest.startsWith('[')) {
      tags.push(...parseTagsFromLine(lines[i]));
    } else if (rest === '') {
      for (let j = i + 1; j < frontmatterEnd; j++) {
        const item = lines[j].match(/^\s*-\s*(.+?)\s*$/);
        if (!item) break;
        tags.push(stripQuotes(item[1]));
      }
    } else {
      tags.push(...rest.split(',').map(t => stripQuotes(t.trim())));
    }
    break;
  }

  return tags.filter(Boolean);
}

/** Rename a tag inside YAML frontmatter (`tags: [...]` array, comma list, or `- item` block). */
function renameFrontmatterTag(
  content: string,
  oldTag: string,
  newTag: string,
  caseSensitive: boolean,
): { content: string; count: number } {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { content, count: 0 };

  let frontmatterEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      frontmatterEnd = i;
      break;
    }
  }
  if (frontmatterEnd === -1) return { content, count: 0 };

  const isMatch = (value: string): boolean =>
    caseSensitive ? value === oldTag : value.toLowerCase() === oldTag.toLowerCase();

  let count = 0;
  for (let i = 1; i < frontmatterEnd; i++) {
    const header = lines[i].match(/^(\s*tags:\s*)(.*)$/);
    if (!header) continue;

    const prefix = header[1];
    const rest = header[2].trim();

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const renamed = rest
        .slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(item => {
          if (isMatch(stripQuotes(item))) {
            count++;
            return newTag;
          }
          return item;
        });
      lines[i] = `${prefix}[${renamed.join(', ')}]`;
    } else if (rest === '') {
      for (let j = i + 1; j < frontmatterEnd; j++) {
        const item = lines[j].match(/^(\s*-\s*)(.+?)(\s*)$/);
        if (!item) break;
        if (isMatch(stripQuotes(item[2]))) {
          count++;
          lines[j] = `${item[1]}${newTag}${item[3]}`;
        }
      }
    } else {
      const renamed = rest
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(item => {
          if (isMatch(stripQuotes(item))) {
            count++;
            return newTag;
          }
          return item;
        });
      lines[i] = `${prefix}${renamed.join(', ')}`;
    }
    break;
  }

  return { content: lines.join('\n'), count };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
