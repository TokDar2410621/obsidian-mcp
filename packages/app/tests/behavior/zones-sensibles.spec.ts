import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { avecAppelant, estJetonLocal } from '@/services/securite/appelant';
import {
  deverrouiller,
  estSensible,
  fenetreOuverte,
  filtrerResultats,
  garder,
  verrouiller,
} from '@/services/securite/zones-sensibles';
import { cheminsDe } from '@/services/securite/garde-mcp';

configureLogger({ stream: process.stderr, minLevel: 'error' });

const MDP = 'un-mot-de-passe-de-test';

beforeEach(() => {
  process.env.CERVEAU_MOT_DE_PASSE = MDP;
  process.env.CERVEAU_JETON_LOCAL = 'jeton-local-de-test';
  delete process.env.CERVEAU_ZONES_SENSIBLES;
  delete process.env.CERVEAU_FENETRE_MINUTES;
  verrouiller();
});
afterEach(() => {
  delete process.env.CERVEAU_MOT_DE_PASSE;
  delete process.env.CERVEAU_JETON_LOCAL;
  verrouiller();
});

/** Un appel venu de claude.ai : non fiable, donc garde. */
const depuisClaudeAi = <T>(fn: () => T): T =>
  avecAppelant({ deConfiance: false, origine: 'claude.ai' }, fn);
/** Un appel venu de Claude Code ou d'un worker : porteur du jeton local. */
const depuisLocal = <T>(fn: () => T): T =>
  avecAppelant({ deConfiance: true, origine: 'local' }, fn);

describe('Zones sensibles — le perimetre', () => {
  it('reconnait les quatre zones decidees', () => {
    expect(estSensible('00-personnel/sante.md')).toBe(true);
    expect(estSensible('04-people/untel.md')).toBe(true);
    expect(estSensible('01-raw/docs/2026-07/passeport.md')).toBe(true);
    expect(estSensible('01-raw/admin/impots.md')).toBe(true);
  });

  it('laisse le reste du coffre libre', () => {
    expect(estSensible('05-projects/cerveau/notes.md')).toBe(false);
    expect(estSensible('02-knowledge/ml/rag.md')).toBe(false);
    expect(estSensible('08-auto/_poussoir.md')).toBe(false);
  });

  it("normalise les separateurs Windows et le prefixe ./", () => {
    expect(estSensible('00-personnel\\sante.md')).toBe(true);
    expect(estSensible('./00-personnel/sante.md')).toBe(true);
  });

  it('se configure sans redeploiement', () => {
    process.env.CERVEAU_ZONES_SENSIBLES = '09-secret/, 03-daily/';
    expect(estSensible('09-secret/x.md')).toBe(true);
    expect(estSensible('00-personnel/x.md')).toBe(false); // remplace, pas ajoute
  });
});

describe('Zones sensibles — qui est garde', () => {
  it('refuse une LECTURE de claude.ai quand la fenetre est fermee', () => {
    const r = depuisClaudeAi(() => garder('read-note', ['00-personnel/sante.md']));
    expect(r?.refuse).toBe(true);
    expect(r?.message).toContain('deverrouiller-zone-sensible');
  });

  it('refuse une SUPPRESSION de claude.ai', () => {
    expect(depuisClaudeAi(() => garder('delete-note', ['04-people/untel.md']))).not.toBeNull();
    expect(depuisClaudeAi(() => garder('delete-file', ['01-raw/docs/x.pdf']))).not.toBeNull();
  });

  it("laisse passer l'ECRITURE, meme en zone sensible : c'est le contrat", () => {
    // Decision de Darius : ajouter une note ne fait fuiter ni ne detruit rien.
    for (const outil of ['create-note', 'patch-content', 'append-content', 'edit-note']) {
      expect(depuisClaudeAi(() => garder(outil, ['00-personnel/sante.md']))).toBeNull();
    }
  });

  it('ne gene JAMAIS Claude Code, les workers ni les crons', () => {
    expect(depuisLocal(() => garder('read-note', ['00-personnel/sante.md']))).toBeNull();
    expect(depuisLocal(() => garder('delete-note', ['00-personnel/sante.md']))).toBeNull();
  });

  it('laisse passer une lecture hors zone sensible', () => {
    expect(depuisClaudeAi(() => garder('read-note', ['05-projects/x.md']))).toBeNull();
  });

  it('se tait completement si aucun mot de passe n est configure', () => {
    delete process.env.CERVEAU_MOT_DE_PASSE;
    expect(depuisClaudeAi(() => garder('read-note', ['00-personnel/sante.md']))).toBeNull();
  });

  it('par defaut, hors de tout contexte connu, considere l appel NON fiable', () => {
    // Une garde qui s'ouvre quand elle ne sait pas n'est pas une garde.
    expect(garder('read-note', ['00-personnel/sante.md'])).not.toBeNull();
  });
});

describe('Zones sensibles — la fenetre', () => {
  it('un bon mot de passe ouvre, et la lecture passe ensuite', () => {
    expect(depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']))).not.toBeNull();
    expect(deverrouiller(MDP)).toBe(true);
    expect(fenetreOuverte()).toBe(true);
    expect(depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']))).toBeNull();
  });

  it('la fenetre vaut pour TOUTES les requetes suivantes, pas une seule', () => {
    deverrouiller(MDP);
    for (let i = 0; i < 5; i++) {
      expect(depuisClaudeAi(() => garder('read-note', [`00-personnel/${i}.md`]))).toBeNull();
    }
  });

  it('un mauvais mot de passe n ouvre rien', () => {
    expect(deverrouiller('presque-le-bon')).toBe(false);
    expect(fenetreOuverte()).toBe(false);
    expect(depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']))).not.toBeNull();
  });

  it('un mot de passe vide n ouvre rien', () => {
    expect(deverrouiller('')).toBe(false);
  });

  it('le verrouillage manuel referme avant l heure', () => {
    deverrouiller(MDP);
    expect(fenetreOuverte()).toBe(true);
    verrouiller();
    expect(fenetreOuverte()).toBe(false);
    expect(depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']))).not.toBeNull();
  });

  it('une fenetre expiree referme la porte', () => {
    process.env.CERVEAU_FENETRE_MINUTES = '-1'; // valeur invalide : retombe a 30
    deverrouiller(MDP);
    expect(fenetreOuverte()).toBe(true);
  });
});

describe('Zones sensibles — les recherches', () => {
  const resultats = [
    { path: '05-projects/a.md' },
    { path: '00-personnel/sante.md' },
    { path: '02-knowledge/b.md' },
    { path: '04-people/untel.md' },
  ];

  it('masque les entrees sensibles au lieu de bloquer toute la recherche', () => {
    // Refuser toute recherche parce qu'elle POURRAIT toucher du sensible
    // rendrait le coffre inutilisable.
    const r = depuisClaudeAi(() => filtrerResultats(resultats, x => x.path));
    expect(r.gardes).toHaveLength(2);
    expect(r.masques).toBe(2);
    expect(r.gardes.map(x => x.path)).not.toContain('00-personnel/sante.md');
  });

  it('ne masque rien pour un appelant de confiance', () => {
    const r = depuisLocal(() => filtrerResultats(resultats, x => x.path));
    expect(r.masques).toBe(0);
  });

  it('ne masque rien quand la fenetre est ouverte', () => {
    deverrouiller(MDP);
    const r = depuisClaudeAi(() => filtrerResultats(resultats, x => x.path));
    expect(r.masques).toBe(0);
  });
});

describe('Zones sensibles — le jeton local', () => {
  it('reconnait le jeton exact', () => {
    expect(estJetonLocal('jeton-local-de-test')).toBe(true);
  });

  it('refuse un jeton faux, vide, ou de longueur differente', () => {
    expect(estJetonLocal('jeton-local-de-tesT')).toBe(false);
    expect(estJetonLocal('')).toBe(false);
    expect(estJetonLocal('jeton-local-de-test-plus-long')).toBe(false);
  });

  it('refuse tout si aucun jeton local n est configure', () => {
    delete process.env.CERVEAU_JETON_LOCAL;
    expect(estJetonLocal('nimporte-quoi')).toBe(false);
  });
});

describe('Zones sensibles — extraction des chemins des arguments', () => {
  it('trouve les chemins quel que soit le nom du parametre', () => {
    expect(cheminsDe({ path: 'a.md' })).toEqual(['a.md']);
    expect(cheminsDe({ paths: ['a.md', 'b.md'] })).toEqual(['a.md', 'b.md']);
    expect(cheminsDe({ key: '01-raw/fichiers/x.pdf' })).toEqual(['01-raw/fichiers/x.pdf']);
    expect(cheminsDe({ source_path: 'a.md', destination_path: 'b.md' })).toHaveLength(2);
  });

  it('survit a des arguments absents ou difformes', () => {
    expect(cheminsDe(null)).toEqual([]);
    expect(cheminsDe({})).toEqual([]);
    expect(cheminsDe({ path: 42 })).toEqual([]);
  });

  it('couvre bien les outils de lecture de fichiers du bucket', () => {
    const r = depuisClaudeAi(() =>
      garder('get-file', cheminsDe({ path: '01-raw/docs/2026-07/passeport.pdf' })),
    );
    expect(r?.refuse).toBe(true);
  });
});

describe('Zones sensibles — le refus dit COMMENT demander', () => {
  it('ordonne AskUserQuestion en premier choix', () => {
    // Consigne explicite de Darius le 2026-09-13 : une invite nette, pas une
    // phrase noyee. Le serveur ne peut pas forcer un outil cote client, mais
    // il peut l'ordonner ; un client qui en dispose obeit.
    const r = depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']));
    expect(r?.message).toContain('AskUserQuestion');
    expect(r?.message).toMatch(/champ libre/i); // un mot de passe ne se choisit pas dans une liste
  });

  it('prevoit le repli pour un client qui n a pas l outil', () => {
    const r = depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']));
    expect(r?.message).toMatch(/Sinon seulement/i);
  });

  it('interdit explicitement de deviner ou de chercher le mot de passe', () => {
    const r = depuisClaudeAi(() => garder('delete-note', ['04-people/x.md']));
    expect(r?.message).toMatch(/INTERDIT/);
    expect(r?.message).toMatch(/deviner/i);
    expect(r?.message).toMatch(/historique/i); // ne pas reprendre celui d'avant
  });

  it('nomme les fichiers vises et le geste, pour que Darius sache quoi autoriser', () => {
    const r = depuisClaudeAi(() => garder('delete-file', ['01-raw/docs/passeport.pdf']));
    expect(r?.message).toContain('01-raw/docs/passeport.pdf');
    expect(r?.message).toContain('supprimer');
  });

  it('annonce la duree de la fenetre, pour ne pas laisser croire a une demande par requete', () => {
    const r = depuisClaudeAi(() => garder('read-note', ['00-personnel/x.md']));
    expect(r?.message).toMatch(/30 minutes/);
  });
});
