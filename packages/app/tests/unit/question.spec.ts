import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });

import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import type { MatiereManquante } from '@/services/livraison/matiere-manquante';
import {
  STATUT_QUESTION,
  extraireRef,
  notificationQuestion,
  prefillQuestion,
  refTache,
  reprendreApresReponse,
  resoudreRef,
} from '@/services/livraison/question';

/**
 * La question posee : ce qui remplace « valide pour ne plus le voir ».
 *
 * Le fil complet tient en quatre pieces testees ici : une reference courte qui
 * tient dans une dictee, une notification qui porte la question verbatim sans
 * jamais montrer le jeton, la resolution de la reference vers une fiche, et la
 * reprise qui remet la piece manquante dans la Demande.
 */

const JETON = 'jeton-de-test';

const MATIERE: MatiereManquante = {
  bloque: true,
  question:
    "quelle est la méthode ou le format montré dans la vidéo (ou un texte/capture d'écran de son contenu) ?",
  piece: 'une capture du contenu',
  motif: 'critere-ko',
};

const fiche = (statut: string): string =>
  [
    '---',
    'type: tache',
    `statut: ${statut}`,
    'risque: sans-risque',
    'source: telephone',
    'created: 2026-08-31',
    '---',
    '',
    '# Appliquer ca pour gridar et Arivex',
    '',
    '## Demande',
    'Appliquer ça pour gridar et Arivex pour chaque question planifie des reponses',
    'Lien joint : https://www.facebook.com/share/r/1H4AxK34gN/',
    '',
    '## Critères de fini',
    '- [ ] La demande est satisfaite telle quénoncée.',
    '',
    '## Résultat',
    '',
    'criteres: demande satisfaite=KO acces video bloque',
    '',
  ].join('\n');

describe('Question : la reference de tache', () => {
  it('rend huit caracteres hexadecimaux, stables', () => {
    const r = refTache('09-taches/2026-08-31-appliquer.md');
    expect(r).toMatch(/^[0-9a-f]{8}$/);
    expect(refTache('09-taches/2026-08-31-appliquer.md')).toBe(r);
  });

  it('distingue deux chemins differents', () => {
    expect(refTache('09-taches/a.md')).not.toBe(refTache('09-taches/b.md'));
  });

  it('se prefille exactement comme la dictee l attend', () => {
    expect(prefillQuestion('ab12cd34')).toBe('pk: [t:ab12cd34] ');
  });

  it('se ressort du texte dicte', () => {
    expect(extraireRef('[t:ab12cd34] le lien est ici')).toEqual({
      ref: 'ab12cd34',
      texte: 'le lien est ici',
    });
  });

  it('laisse passer une dictee libre, sans reference', () => {
    expect(extraireRef('juste du texte dicte')).toEqual({
      ref: null,
      texte: 'juste du texte dicte',
    });
  });

  it('tolere l espace avale par la dictee du telephone', () => {
    expect(extraireRef('[t:ab12cd34]le lien')).toEqual({ ref: 'ab12cd34', texte: 'le lien' });
  });
});

describe('Question : la notification', () => {
  const pousse = (over: Record<string, unknown> = {}) =>
    notificationQuestion({
      titre: 'Appliquer ca pour gridar et Arivex',
      matiere: MATIERE,
      chemin: '09-taches/2026-08-31-appliquer.md',
      baseUrl: 'https://cerveau.example',
      token: JETON,
      ...over,
    });

  it('porte la question VERBATIM, et jamais « Le livrable est prêt »', () => {
    const n = pousse();
    expect(n.message).toContain(MATIERE.question);
    expect(n.message).toContain('Réponds en vocal : un tap sur Répondre.');
    expect(n.message).not.toContain('Le livrable est prêt');
    expect(n.title).toBe('❓ Il me manque : une capture du contenu');
  });

  it('n expose JAMAIS le jeton dans ce qui s affiche', () => {
    const n = pousse();
    expect(n.title + n.message).not.toContain(JETON);
  });

  it('normalise un baseUrl termine par un slash', () => {
    const n = pousse({ baseUrl: 'https://cerveau.example/' });
    const urls = [n.click ?? '', ...(n.actions ?? []).map(a => a.url)].join(' ');
    expect(urls).not.toContain('//capture');
    expect(urls).not.toContain('//revue');
    expect(urls).not.toContain('//rejette');
    expect(n.click).toContain('https://cerveau.example/capture/app?k=');
  });

  it('tient dans les trois actions de ntfy, sans bouton Valider', () => {
    const n = pousse();
    expect(n.actions).toHaveLength(3);
    expect(n.actions?.map(a => a.label)).toEqual(['Répondre', 'Abandonner', 'Revue']);
    expect(n.actions?.map(a => a.label)).not.toContain('Valider');
    expect(n.actions?.[0].url).toContain(
      encodeURIComponent(prefillQuestion(refTache('09-taches/2026-08-31-appliquer.md'))),
    );
  });

  it('part quand meme sans jeton : zero action, zero click, aucune exception', () => {
    const n = pousse({ token: null });
    expect(n.actions).toBeUndefined();
    expect(n.click).toBeUndefined();
    expect(n.message).toContain(MATIERE.question);
  });
});

describe('Question : resoudre une reference', () => {
  it('retrouve la fiche que la reference designe', async () => {
    const vault = new InMemoryVaultManager({
      '09-taches/a.md': fiche(STATUT_QUESTION),
      '09-taches/b.md': fiche('a-valider'),
      '09-taches/_reponses.md': '# Réponses',
    });
    expect(await resoudreRef(vault, refTache('09-taches/a.md'))).toBe('09-taches/a.md');
  });

  it('rend null sur une reference inconnue ou mal formee', async () => {
    const vault = new InMemoryVaultManager({ '09-taches/a.md': fiche(STATUT_QUESTION) });
    expect(await resoudreRef(vault, 'deadbeef')).toBeNull();
    expect(await resoudreRef(vault, 'pas-une-ref')).toBeNull();
    expect(await resoudreRef(vault, '')).toBeNull();
  });
});

describe('Question : la reprise apres reponse', () => {
  it('remet la tache en proposee et met la reponse dans la Demande', async () => {
    const vault = new InMemoryVaultManager({ '09-taches/a.md': fiche(STATUT_QUESTION) });
    const ok = await reprendreApresReponse(vault, '09-taches/a.md', 'la video montre un plan de contenu');
    expect(ok).toBe(true);

    const apres = await vault.readFile('09-taches/a.md');
    expect(apres).toContain('statut: proposee');
    const demande = apres.slice(apres.indexOf('## Demande'), apres.indexOf('## Critères'));
    expect(demande).toContain('la video montre un plan de contenu');
    expect(demande).toMatch(/\*\*Réponse de Darius \(\d{4}-\d{2}-\d{2}\)\*\* :/);
    // La demande d'origine reste entiere : la reponse s'ajoute, elle n'ecrase rien.
    expect(demande).toContain('Appliquer ça pour gridar et Arivex');
  });

  it('ne fait QU UNE ecriture, jamais deux', async () => {
    // Deux writeFile valent deux commit et deux push : la tempete documentee
    // dans vault-manager.ts:106-109 (79 commits sur 141 en un jour).
    const vault = new InMemoryVaultManager({ '09-taches/a.md': fiche(STATUT_QUESTION) });
    let ecritures = 0;
    const original = vault.writeFile.bind(vault);
    vault.writeFile = async (p: string, c: string) => {
      ecritures++;
      return original(p, c);
    };
    await reprendreApresReponse(vault, '09-taches/a.md', 'la voici');
    expect(ecritures).toBe(1);
  });

  it('n ecrit RIEN quand la tache n attend plus de reponse', async () => {
    // Idempotence : jamais de resurrection d'une tache rejetee entre-temps.
    const vault = new InMemoryVaultManager({ '09-taches/a.md': fiche('rejetee') });
    let ecritures = 0;
    const original = vault.writeFile.bind(vault);
    vault.writeFile = async (p: string, c: string) => {
      ecritures++;
      return original(p, c);
    };
    expect(await reprendreApresReponse(vault, '09-taches/a.md', 'la voici')).toBe(false);
    expect(ecritures).toBe(0);
    expect(await vault.readFile('09-taches/a.md')).toContain('statut: rejetee');
  });

  it('ne fait rien sur une reponse vide ou une fiche absente', async () => {
    const vault = new InMemoryVaultManager({ '09-taches/a.md': fiche(STATUT_QUESTION) });
    expect(await reprendreApresReponse(vault, '09-taches/a.md', '   ')).toBe(false);
    expect(await reprendreApresReponse(vault, '09-taches/absente.md', 'la voici')).toBe(false);
  });
});
