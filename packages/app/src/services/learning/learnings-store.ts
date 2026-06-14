import type { VaultManager } from '@/services/vault-manager';

/**
 * The feedback memory: a single `_learnings.md` note holding Darius's
 * preferences and corrections. This is "in-context DPO" — instead of retraining,
 * the agents read these lines before acting (see RagService learnings provider).
 */
export const LEARNINGS_FILE = '_learnings.md';

const HEADER = [
  '---',
  'type: learning',
  'tags: [learning]',
  '---',
  '',
  "# Préférences & corrections (lues avant d'agir)",
  '',
  'Le cerveau lit ces consignes avant de répondre. Ajoute via le tool `remember-preference`.',
  '',
].join('\n');

export class LearningsStore {
  constructor(private readonly vault: VaultManager) {}

  /** The current learnings body (no frontmatter). Empty string if none yet. */
  async getLearnings(): Promise<string> {
    try {
      if (!(await this.vault.fileExists(LEARNINGS_FILE))) return '';
      return stripFrontmatter(await this.vault.readFile(LEARNINGS_FILE)).trim();
    } catch {
      return '';
    }
  }

  /** Append one preference/correction. Creates the note if missing. */
  async addPreference(text: string): Promise<{ path: string; total: number }> {
    const clean = text.replace(/\s+/g, ' ').trim();
    let body = '';
    try {
      if (await this.vault.fileExists(LEARNINGS_FILE))
        body = await this.vault.readFile(LEARNINGS_FILE);
    } catch {
      /* fall through to fresh file */
    }
    if (!body.trim()) body = HEADER;
    if (!body.endsWith('\n')) body += '\n';
    body += `- ${clean}\n`;
    await this.vault.writeFile(LEARNINGS_FILE, body);
    const total = (body.match(/^- /gm) ?? []).length;
    return { path: LEARNINGS_FILE, total };
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  return end === -1 ? content : content.slice(end + 4);
}
