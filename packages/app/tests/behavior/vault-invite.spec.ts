import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { registerTools } from '@/mcp/tool-registrations';
import { VaultInvite, messageIntrouvable, MESSAGE_LECTURE_SEULE } from '@/services/invites/vault-invite';
import { deverrouiller, filtrerResultats, verrouiller } from '@/services/securite/zones-sensibles';
import { RagService } from '@/services/rag/rag-service';
import type { EmbeddingProvider, VaultReader } from '@/services/rag/types';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';

configureLogger({ stream: process.stderr, minLevel: 'error' });

/**
 * Dan (l'instance invitee) voit le coffre a travers VaultInvite. Ces tests
 * epinglent les trois promesses de la spec du 2026-10-07 : rien des zones
 * cachees ne sort, un chemin cache ressemble trait pour trait a un chemin
 * absent, et rien ne s'ecrit.
 */

const SECRET = 'TERME-PERSONNEL-INVENTE-7731';

function coffre(): InMemoryVaultManager {
  return new InMemoryVaultManager({
    '00-personnel/finances.md': `# Finances\n\n${SECRET} loyer.\n`,
    '04-people/ami.md': `# Ami\n\n${SECRET}\n`,
    'Personnes/Oncle.md': `# Oncle\n\n${SECRET}\n`,
    '01-raw/docs/passeport.md': `# Passeport\n\n${SECRET}\n`,
    '01-raw/inbox/idee.md': '# Idee\n\nUne idee publique.\n',
    '05-projects/offre/playbook.md': '# Playbook\n\nComment construire une offre.\n',
    'Journal/2026-07-08.md': '# Journal\n\nUne journee.\n',
  });
}

type Outil = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function outils(vault: VaultInvite): Map<string, Outil> {
  const map = new Map<string, Outil>();
  const faux = {
    registerTool: (nom: string, _def: unknown, handler: Outil) => map.set(nom, handler),
  };
  registerTools(faux as never, () => vault);
  return map;
}

beforeEach(() => {
  process.env.GUEST_MODE = 'true';
  delete process.env.CERVEAU_ZONES_SENSIBLES;
  delete process.env.CERVEAU_MOT_DE_PASSE;
  verrouiller();
});
afterEach(() => {
  delete process.env.GUEST_MODE;
  delete process.env.CERVEAU_MOT_DE_PASSE;
  verrouiller();
});

describe('VaultInvite : lecture', () => {
  it('lit une note visible', async () => {
    const dan = new VaultInvite(coffre());
    expect(await dan.readFile('05-projects/offre/playbook.md')).toContain('construire une offre');
  });

  it('un chemin cache et un chemin absent rendent le meme message', async () => {
    const dan = new VaultInvite(coffre());
    const cache = await dan.readFile('00-personnel/finances.md').catch(e => String(e.message));
    const absent = await dan.readFile('00-personnel/nexiste-pas.md').catch(e => String(e.message));
    expect(cache).toBe(messageIntrouvable('00-personnel/finances.md'));
    expect(absent).toBe(messageIntrouvable('00-personnel/nexiste-pas.md'));
    expect(cache.replace('finances', 'X')).toBe(absent.replace('nexiste-pas', 'X'));
  });

  it.each([
    './00-personnel/finances.md',
    '00-personnel//finances.md',
    '00-personnel\\finances.md',
    'Personnes/Oncle.md',
    '01-raw/docs/passeport.md',
    '../00-personnel/finances.md',
    'C:\\vault\\00-personnel\\finances.md',
  ])('refuse le detour %s avec le message generique', async chemin => {
    const dan = new VaultInvite(coffre());
    await expect(dan.readFile(chemin)).rejects.toThrow(messageIntrouvable(chemin));
    expect(await dan.fileExists(chemin)).toBe(false);
  });

  it('les zones ajoutees par CERVEAU_ZONES_SENSIBLES s ajoutent aux zones invitees', async () => {
    process.env.CERVEAU_ZONES_SENSIBLES = 'Journal/';
    const dan = new VaultInvite(coffre());
    await expect(dan.readFile('Journal/2026-07-08.md')).rejects.toThrow('Introuvable');
    await expect(dan.readFile('00-personnel/finances.md')).rejects.toThrow('Introuvable');
  });
});

describe('VaultInvite : listings', () => {
  it('ne liste ni les fichiers ni les dossiers caches', async () => {
    const dan = new VaultInvite(coffre());
    const tout = await dan.listFiles('', { recursive: true, includeDirectories: true });
    expect(tout).toContain('05-projects/offre/playbook.md');
    expect(tout).not.toContain('01-raw/inbox/idee.md');
    for (const p of tout) {
      expect(p).not.toMatch(/^(00-personnel|04-people|Personnes|01-raw|Journal|03-daily|09-taches|09-archive)/);
    }
  });

  it('un dossier cache se liste comme un dossier absent', async () => {
    const dan = new VaultInvite(coffre());
    await expect(dan.listFiles('00-personnel')).rejects.toThrow(messageIntrouvable('00-personnel'));
  });
});

describe('VaultInvite : lecture seule', () => {
  it.each(['writeFile', 'deleteFile', 'moveFile', 'createDirectory', 'writeFileLazy'] as const)(
    '%s echoue sans toucher au coffre',
    async methode => {
      const interne = coffre();
      const dan = new VaultInvite(interne);
      await expect((dan[methode] as (...a: unknown[]) => Promise<void>)('05-projects/x.md', 'y')).rejects.toThrow(
        MESSAGE_LECTURE_SEULE,
      );
      expect(await interne.fileExists('05-projects/x.md')).toBe(false);
    },
  );
});

describe('outils MCP a travers VaultInvite', () => {
  it('read-notes : une entree cachee et une entree absente sont identiques', async () => {
    const t = outils(new VaultInvite(coffre()));
    const r = await t.get('read-notes')!({ paths: ['Personnes/Oncle.md', 'Personnes/Tante.md'] });
    const notes = r.structuredContent!.notes as Array<{ success: boolean; error: string }>;
    expect(notes).toHaveLength(2);
    expect(notes[0].success).toBe(false);
    expect(notes[0].error.replace('Oncle', 'X')).toBe(notes[1].error.replace('Tante', 'X'));
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain('masques_zone_sensible');
  });

  it('search-vault ne trouve pas le terme personnel', async () => {
    const t = outils(new VaultInvite(coffre()));
    const r = await t.get('search-vault')!({ query: SECRET, exact: true });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.structuredContent!.total_matches).toBe(0);
  });

  it('create-note est refuse en lecture seule', async () => {
    const t = outils(new VaultInvite(coffre()));
    const r = await t.get('create-note')!({ path: '05-projects/pirate.md', content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('lecture seule');
  });
});

describe('zones sensibles en mode invite', () => {
  it('deverrouiller refuse meme le bon mot de passe', () => {
    process.env.CERVEAU_MOT_DE_PASSE = 'le-bon';
    expect(deverrouiller('le-bon')).toBe(false);
  });

  it('filtrerResultats mord sans mot de passe configure', () => {
    const { gardes, masques } = filtrerResultats(
      ['00-personnel/a.md', 'Personnes/b.md', '05-projects/c.md'],
      p => p,
    );
    expect(gardes).toEqual(['05-projects/c.md']);
    expect(masques).toBe(2);
  });
});

describe('index RAG construit a travers VaultInvite', () => {
  class Embedder implements EmbeddingProvider {
    readonly model = 'jouet';
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(t => (t.includes(SECRET) ? [1, 0] : [0.2, 1]));
    }
  }

  it('aucun extrait cache dans l index ni dans les resultats', async () => {
    const dan = new VaultInvite(coffre());
    const reader: VaultReader = {
      listMarkdownFiles: () => dan.listFiles('', { recursive: true, fileTypes: ['md'] }),
      readFile: p => dan.readFile(p),
    };
    const rag = new RagService({
      reader,
      embedder: new Embedder(),
      generator: null,
      indexFile: 'inutile.json',
      persist: false,
    });
    await rag.ensureReady();
    expect(rag.embeddedChunks.some(c => c.text.includes(SECRET))).toBe(false);
    const r = await rag.searchCerveau({ query: SECRET });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain('masques_zone_sensible');
  });
});
