import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  construireCatalogue,
  enrichir,
  lireListeCuree,
  resoudreSource,
  valeurYaml,
} from '@/cli/sync-skills-catalog';

const TIRET = String.fromCharCode(0x2014);

/** La synchro du catalogue (spec du 2026-10-07, §2.1 et §2.2). */

describe('lireListeCuree', () => {
  it('lit les collections, leurs licences et leurs skills', () => {
    const c = lireListeCuree(
      [
        '# commentaire',
        '[superpowers] source=~/plugins/superpowers/* licence=fichier:LICENSE url=https://x',
        'systematic-debugging',
        'brainstorming  # en ligne',
        '',
        '[darius] source=~/.claude/skills licence=par-skill',
        'stop-slop',
      ].join('\n'),
    );
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({
      nom: 'superpowers',
      licence: { type: 'fichier', chemin: 'LICENSE' },
      url: 'https://x',
      skills: ['systematic-debugging', 'brainstorming'],
    });
    expect(c[1].licence).toEqual({ type: 'par-skill' });
  });

  it('refuse une licence absente ou un skill hors collection', () => {
    expect(() => lireListeCuree('[x] source=/a')).toThrow(/licence/);
    expect(() => lireListeCuree('orphelin')).toThrow(/hors collection/);
    expect(() => lireListeCuree('[x] source=/a licence=par-skill\n../evasion')).toThrow(/invalide/);
  });
});

describe('valeurYaml', () => {
  it.each([
    ['description: simple valeur', 'simple valeur'],
    ['description: "avec \\"guillemets\\" et : deux-points"', 'avec "guillemets" et : deux-points'],
    ["description: 'apostrophe ''doublee'''", "apostrophe 'doublee'"],
    ['description: >\n  plie sur\n  deux lignes\nname: x', 'plie sur deux lignes'],
    ['description: debut\n  suite indentee\nname: x', 'debut suite indentee'],
  ])('%s', (fm, attendu) => {
    expect(valeurYaml(fm, 'description')).toBe(attendu);
  });

  it('rend null pour une cle absente', () => {
    expect(valeurYaml('name: x', 'description')).toBeNull();
  });
});

describe('enrichir', () => {
  it('ajoute les cles manquantes sans toucher aux lignes d origine', () => {
    const avant = '---\nname: x\ndescription: "a: b"\ntype: deja\n---\n\n# Corps\n';
    const apres = enrichir(avant, [
      ['catalogue_nom', 'c-x'],
      ['type', 'document'],
    ]);
    expect(apres).toBe('---\nname: x\ndescription: "a: b"\ntype: deja\ncatalogue_nom: c-x\n---\n\n# Corps\n');
  });

  it('cree un frontmatter quand il n y en a pas', () => {
    expect(enrichir('# Ref\n', [['type', 'document']])).toBe('---\ntype: document\n---\n\n# Ref\n');
  });
});

function fixture(): { maison: string; liste: string } {
  const maison = mkdtempSync(path.join(tmpdir(), 'skills-src-'));
  const plugin = path.join(maison, 'plugins', 'sp', '1.10.0');
  mkdirSync(path.join(maison, 'plugins', 'sp', '1.9.0'), { recursive: true });
  mkdirSync(path.join(plugin, 'skills', 'cat', 'debug', 'references'), { recursive: true });
  writeFileSync(path.join(plugin, 'LICENSE'), 'MIT License\n\nCopyright (c) Test');
  writeFileSync(
    path.join(plugin, 'skills', 'cat', 'debug', 'SKILL.md'),
    `---\nname: debug\ndescription: Use when a bug ${TIRET} any bug\n---\n\n# Debug\n\nCorps.\n`,
  );
  writeFileSync(path.join(plugin, 'skills', 'cat', 'debug', 'references', 'guide.md'), '# Guide\n');
  writeFileSync(path.join(plugin, 'skills', 'cat', 'debug', 'script.sh'), 'echo');
  const perso = path.join(maison, 'perso');
  mkdirSync(path.join(perso, 'sans-licence'), { recursive: true });
  writeFileSync(path.join(perso, 'sans-licence', 'SKILL.md'), '---\nname: s\ndescription: d\n---\nx');
  mkdirSync(path.join(perso, 'mit'), { recursive: true });
  writeFileSync(path.join(perso, 'mit', 'SKILL.md'), '---\nname: mit\ndescription: d\nlicense: MIT\n---\nx');
  const liste = [
    '[sp] source=~/plugins/sp/* licence=fichier:LICENSE',
    'debug',
    'introuvable',
    '[darius] source=~/perso licence=par-skill',
    'sans-licence',
    'mit',
  ].join('\n');
  return { maison, liste };
}

describe('resoudreSource', () => {
  it('prend la version la plus recente en ordre numerique (1.10 > 1.9)', () => {
    const { maison } = fixture();
    expect(path.basename(resoudreSource('~/plugins/sp/*', maison))).toBe('1.10.0');
  });
});

describe('construireCatalogue', () => {
  it('copie les skills listes, leurs references, les licences et le hub', async () => {
    const { maison, liste } = fixture();
    const r = await construireCatalogue(lireListeCuree(liste), {
      maison,
      dossierListe: maison,
      date: '2026-10-07',
    });
    const chemins = r.fichiers.map(f => f.chemin).sort();
    expect(chemins).toEqual([
      '09-skills/_index.md',
      '09-skills/darius/mit.md',
      '09-skills/sp/LICENSE.md',
      '09-skills/sp/debug.md',
      '09-skills/sp/debug/references/guide.md',
    ]);
    const fiche = r.fichiers.find(f => f.chemin === '09-skills/sp/debug.md')!.contenu;
    expect(fiche).toContain('catalogue_nom: sp-debug');
    expect(fiche).toContain('source: "sp 1.10.0"');
    expect(fiche).toContain('fichiers_non_copies: 1');
    expect(fiche).toContain('# Debug');
    // Zero em-dash, comme le serveur l'assainirait a l'ecriture.
    for (const f of r.fichiers) expect(f.contenu).not.toContain(TIRET);
    expect(r.ignores).toEqual([
      { collection: 'sp', skill: 'introuvable', raison: 'dossier introuvable' },
      { collection: 'darius', skill: 'sans-licence', raison: 'aucune licence claire' },
    ]);
    const hub = r.fichiers.find(f => f.chemin === '09-skills/_index.md')!.contenu;
    expect(hub).toContain('[[09-skills/sp/debug|sp-debug]]');
    expect(hub).toContain('type: hub');
  });
});
