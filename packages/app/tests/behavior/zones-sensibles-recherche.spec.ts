import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { avecAppelant } from '@/services/securite/appelant';
import { verrouiller } from '@/services/securite/zones-sensibles';
import { filtrerSortie } from '@/services/securite/garde-mcp';
import { RagService } from '@/services/rag/rag-service';
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import type {
  AnswerGenerator,
  EmbeddingProvider,
  GenContext,
  GenResult,
  VaultReader,
} from '@/services/rag/types';

configureLogger({ stream: process.stderr, minLevel: 'error' });

/**
 * La garde des zones sensibles, branchee sur ce qui SORT.
 *
 * Trouve le 2026-09-17 depuis claude.ai : `read-note` sur
 * `00-personnel/contacts-adresses.md` etait refuse, mais `ask-cerveau` servait
 * le contenu du meme fichier, adresse comprise, sans rien demander. Cause :
 * `garder()` ne refuse que les appels qui NOMMENT un chemin, une recherche
 * n'en nomme aucun, et `filtrerResultats`, ecrite exactement pour ce cas et
 * testee au vert, n'etait appelee par AUCUN code de production.
 *
 * Ces tests echouent tous sur le code d'avant.
 */

const MDP = 'un-mot-de-passe-de-test';
const SECRET = 'RUE-INVENTEE-POUR-LE-TEST-4821';

beforeEach(() => {
  process.env.CERVEAU_MOT_DE_PASSE = MDP;
  delete process.env.CERVEAU_ZONES_SENSIBLES;
  verrouiller();
});
afterEach(() => {
  delete process.env.CERVEAU_MOT_DE_PASSE;
  verrouiller();
});

const depuisClaudeAi = <T>(fn: () => T): T =>
  avecAppelant({ deConfiance: false, origine: 'claude.ai' }, fn);
const depuisLocal = <T>(fn: () => T): T =>
  avecAppelant({ deConfiance: true, origine: 'local' }, fn);

/** Embedder jouet : un seul axe, « adresse ». Tout ce qui en parle colle. */
class EmbedderJouet implements EmbeddingProvider {
  readonly model = 'jouet';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => (/adresse/i.test(t) ? [1, 0] : [0, 1]));
  }
}

/** Redacteur espion : retient EXACTEMENT ce qu'on lui a donne a lire. */
class RedacteurEspion implements AnswerGenerator {
  vus: GenContext[] = [];
  async generate(_question: string, contexts: GenContext[]): Promise<GenResult> {
    this.vus.push(...contexts);
    // Cite la premiere note pour passer le controle d'ancrage, et recopie les
    // extraits : un redacteur reel peut recracher ce qu'on lui montre.
    return {
      answer: `D'apres [[${contexts[0]?.wikilink ?? 'rien'}]] : ${contexts.map(c => c.text).join(' ')}`,
    };
  }
}

function fabrique(): { rag: RagService; redacteur: RedacteurEspion } {
  const vault = new InMemoryVaultManager({
    '00-personnel/contacts-adresses.md': `# Contacts\n\nMon adresse : ${SECRET}.\n`,
    '05-projects/logement/adresse-bureau.md': '# Bureau\n\nAdresse du bureau : 12 rue Publique.\n',
  });
  const reader: VaultReader = {
    listMarkdownFiles: () => vault.listFiles('', { recursive: true, fileTypes: ['md'] }),
    readFile: p => vault.readFile(p),
  };
  const redacteur = new RedacteurEspion();
  const rag = new RagService({
    reader,
    embedder: new EmbedderJouet(),
    generator: redacteur,
    indexFile: '/unused',
    persist: false,
  });
  return { rag, redacteur };
}

describe('Zones sensibles : la recherche semantique', () => {
  it('search-cerveau ne rend plus une note personnelle a claude.ai, et le DIT', async () => {
    const { rag } = fabrique();
    const res = await depuisClaudeAi(() => rag.searchCerveau({ query: 'quelle est mon adresse' }));
    expect(res.success).toBe(true);
    const chemins = res.data.results.map((r: { path: string }) => r.path);
    expect(chemins).not.toContain('00-personnel/contacts-adresses.md');
    expect(res.data.masques_zone_sensible).toBeGreaterThan(0);
  });

  it('ask-cerveau ne montre JAMAIS l extrait sensible au redacteur', async () => {
    // Le point central : filtrer les citations apres coup ne servirait a rien,
    // le contenu serait deja dans la phrase ecrite.
    const { rag, redacteur } = fabrique();
    const res = await depuisClaudeAi(() => rag.askCerveau({ question: 'quelle est mon adresse' }));
    expect(res.success).toBe(true);
    expect(redacteur.vus.some(c => c.text.includes(SECRET))).toBe(false);
    expect(JSON.stringify(res.data)).not.toContain(SECRET);
  });

  it('un appelant de confiance (Claude Code, workers, crons) voit tout', async () => {
    const { rag, redacteur } = fabrique();
    const res = await depuisLocal(() => rag.searchCerveau({ query: 'quelle est mon adresse' }));
    const chemins = res.data.results.map((r: { path: string }) => r.path);
    expect(chemins).toContain('00-personnel/contacts-adresses.md');
    expect(res.data.masques_zone_sensible).toBeUndefined();

    const rep = await depuisLocal(() => rag.askCerveau({ question: 'quelle est mon adresse' }));
    expect(rep.success).toBe(true);
    expect(redacteur.vus.some(c => c.text.includes(SECRET))).toBe(true);
  });

  it('sans mot de passe configure, la garde se tait completement', async () => {
    delete process.env.CERVEAU_MOT_DE_PASSE;
    const { rag } = fabrique();
    const res = await depuisClaudeAi(() => rag.searchCerveau({ query: 'quelle est mon adresse' }));
    const chemins = res.data.results.map((r: { path: string }) => r.path);
    expect(chemins).toContain('00-personnel/contacts-adresses.md');
  });
});

describe('Zones sensibles : le filtre de sortie generique', () => {
  it('retire les chemins sensibles d une liste de fichiers et corrige le compteur', () => {
    const r = depuisClaudeAi(() =>
      filtrerSortie({
        files: ['00-personnel/contacts.md', '05-projects/a.md', '04-people/untel.md'],
        count: 3,
        directory: '.',
      }),
    );
    expect(r.masques).toBe(2);
    const d = r.donnees as { files: string[]; count: number; masques_zone_sensible: number };
    expect(d.files).toEqual(['05-projects/a.md']);
    expect(d.count).toBe(1); // sinon la sortie se contredit elle-meme
    expect(d.masques_zone_sensible).toBe(2);
  });

  it('retire aussi les entrees objet, quel que soit le champ qui porte le chemin', () => {
    const r = depuisClaudeAi(() =>
      filtrerSortie({
        results: [{ path: '01-raw/admin/impots.md' }, { path: '02-knowledge/x.md' }],
        matches: [{ file: '00-personnel/sante.md' }, { file: '08-auto/_poussoir.md' }],
      }),
    );
    expect(r.masques).toBe(2);
  });

  it('ne touche a rien pour un appelant de confiance', () => {
    const entree = { files: ['00-personnel/contacts.md'], count: 1 };
    const r = depuisLocal(() => filtrerSortie(entree));
    expect(r.masques).toBe(0);
    expect(r.donnees).toBe(entree); // objet inchange, pas meme recopie
  });

  it('laisse passer les listes qui ne portent aucun chemin sensible', () => {
    const entree = { tags: ['projet', 'cerveau'], total: 2 };
    const r = depuisClaudeAi(() => filtrerSortie(entree));
    expect(r.masques).toBe(0);
    expect(r.donnees).toBe(entree);
  });
});
