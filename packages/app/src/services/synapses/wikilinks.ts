/**
 * Extract Obsidian wikilink targets from note text.
 *
 * Handles `[[target]]`, `[[target|alias]]`, `[[folder/target|alias]]` and
 * `[[target#heading]]`. Returns normalised link names (basename, no extension,
 * lower-cased) so they can be compared against {@link toWikilink} output.
 */
export function extractWikilinks(content: string): Set<string> {
  const out = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const target = match[1].split('|')[0].split('#')[0].trim();
    if (!target) continue;
    const base = (target.split('/').pop() ?? target).replace(/\.md$/i, '').trim();
    if (base) out.add(base.toLowerCase());
  }
  return out;
}
