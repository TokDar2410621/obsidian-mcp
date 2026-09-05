import { describe, expect, it } from 'vitest';
import { pushDeltaOf, changedNotesOf } from '@/server/local/github-webhook';

/**
 * Le delta d'un push pour le batissage differentiel du graphe.
 *
 * Le point historique : `changedNotesOf` ignorait `commits[].removed`, donc une
 * note effacee du coffre gardait ses noeuds dans le graphe pour toujours. Ces
 * tests verrouillent la lecture des suppressions et l'ordre des evenements
 * dans une rafale de commits.
 */
describe('pushDeltaOf', () => {
  const push = (commits: Array<Record<string, string[]>>) => ({ commits });

  it('lit enfin les suppressions', () => {
    const d = pushDeltaOf(push([{ removed: ['09-taches/vieille-tache.md'] }]));
    expect(d.removed).toEqual(['09-taches/vieille-tache.md']);
    expect(d.changed).toEqual([]);
  });

  it('supprime apres modification = suppression (le dernier etat gagne)', () => {
    const d = pushDeltaOf(
      push([{ modified: ['a.md'] }, { removed: ['a.md'] }]),
    );
    expect(d.removed).toEqual(['a.md']);
    expect(d.changed).toEqual([]);
  });

  it('recree apres suppression = changement', () => {
    const d = pushDeltaOf(push([{ removed: ['a.md'] }, { added: ['a.md'] }]));
    expect(d.changed).toEqual(['a.md']);
    expect(d.removed).toEqual([]);
  });

  it('inclut 08-auto, contrairement aux echos : le delta reflete le build', () => {
    // Les echos excluent 08-auto pour ne pas s'echoer eux-memes ; le graphe,
    // lui, indexe ces notes. Si le delta suivait le filtre des echos, les deux
    // chemins divergeraient et la derive s'installerait.
    const payload = push([{ modified: ['08-auto/_poussoir.md'] }]);
    expect(pushDeltaOf(payload).changed).toEqual(['08-auto/_poussoir.md']);
    expect(changedNotesOf(payload)).toEqual([]);
  });

  it('ignore ce qui n est pas une note', () => {
    const d = pushDeltaOf(
      push([{ modified: ['photo.png', '_templates/gabarit.md'], removed: ['script.py'] }]),
    );
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('survit a un payload difforme', () => {
    expect(pushDeltaOf(null)).toEqual({ changed: [], removed: [] });
    expect(pushDeltaOf({})).toEqual({ changed: [], removed: [] });
    expect(pushDeltaOf({ commits: [{}] })).toEqual({ changed: [], removed: [] });
  });
});
