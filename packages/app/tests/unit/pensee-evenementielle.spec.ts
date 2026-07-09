import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '@/services/graph/knowledge-graph';
import { changedNotesOf, renderEchos } from '@/server/local/github-webhook';
import { normAngle, shouldKillThread } from '@/services/reflection/reflection-service';

// --- spreading activation (graphe) ---------------------------------------------

function smallGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  // qrstudio (mentionné par note-a et note-b) — relié à ar (note-c) — relié à blender (note-d)
  g.addNote('projets/note-a.md', {
    entities: ['QRStudio'],
    relations: [{ source: 'QRStudio', relation: 'possede', target: 'AR' }],
  });
  g.addNote('projets/note-b.md', { entities: ['QRStudio'], relations: [] });
  g.addNote('projets/note-c.md', {
    entities: ['AR'],
    relations: [{ source: 'AR', relation: 'utilise', target: 'Blender' }],
  });
  g.addNote('projets/note-d.md', { entities: ['Blender'], relations: [] });
  g.addNote('loin/note-e.md', { entities: ['Impots'], relations: [] });
  return g;
}

describe('neighborsOfFiles (activation associative)', () => {
  it('wakes direct and 2-hop neighbours with decay, never the input or unrelated notes', () => {
    const g = smallGraph();
    const scores = g.neighborsOfFiles(['projets/note-a.md'], 2);
    // note-b partage l'entité QRStudio (saut 0 sur l'entité même) : réveillée fort.
    expect(scores.get('projets/note-b.md')).toBeGreaterThan(0);
    // note-c est à 1 saut (AR), note-d à 2 sauts (Blender) : décroissance.
    expect(scores.get('projets/note-c.md')).toBeGreaterThan(scores.get('projets/note-d.md') ?? 0);
    // la note déclencheuse et la note sans lien ne sont pas des échos.
    expect(scores.has('projets/note-a.md')).toBe(false);
    expect(scores.has('loin/note-e.md')).toBe(false);
  });
});

// --- webhook helpers -------------------------------------------------------------

describe('changedNotesOf', () => {
  it('collects added+modified .md across commits, excluding agent outputs', () => {
    const payload = {
      commits: [
        { added: ['05-projects/x.md', '08-auto/_insights.md'], modified: ['03-daily/2026-07-09.md'] },
        { added: ['image.png'], modified: ['05-projects/x.md', '_templates/t.md'] },
      ],
    };
    expect(changedNotesOf(payload).sort()).toEqual(['03-daily/2026-07-09.md', '05-projects/x.md']);
  });

  it('tolerates junk payloads', () => {
    expect(changedNotesOf(null)).toEqual([]);
    expect(changedNotesOf({})).toEqual([]);
  });
});

describe('renderEchos', () => {
  it('prepends a dated section with wikilinks and keeps prior sections', () => {
    const first = renderEchos('', '2026-07-09 10:00', ['05-projects/x.md'], [
      { file: '05-projects/y.md', score: 1.5 },
    ]);
    expect(first).toContain('## 2026-07-09 10:00');
    expect(first).toContain('[[05-projects/y]]');
    const second = renderEchos(first, '2026-07-09 11:00', ['03-daily/d.md'], [
      { file: '05-projects/z.md', score: 1 },
    ]);
    expect(second.indexOf('11:00')).toBeLessThan(second.indexOf('10:00')); // newest first
    expect(second).toContain('[[05-projects/z]]');
    expect(second).toContain('[[05-projects/y]]');
  });
});

// --- rumination a angle neuf -----------------------------------------------------

describe('normAngle / shouldKillThread (Zeigarnik avec des dents)', () => {
  it('normalises declared angles', () => {
    expect(normAngle('preuve')).toBe('preuve');
    expect(normAngle('Contre-argument')).toBe('contre');
    expect(normAngle('dissolution du prerequis')).toBe('dissolution');
    expect(normAngle('')).toBe('aucun');
    expect(normAngle(undefined)).toBe('aucun');
    expect(normAngle('rien de neuf')).toBe('aucun');
  });

  it('kills a thread after 3 consecutive cycles without a new angle', () => {
    expect(shouldKillThread(['preuve', 'aucun', 'aucun', 'aucun'])).toBe(true);
    expect(shouldKillThread(['aucun', 'aucun', 'preuve'])).toBe(false);
    expect(shouldKillThread(['aucun', 'aucun'])).toBe(false); // pas encore 3
    expect(shouldKillThread(['preuve', 'contre', 'dissolution'])).toBe(false);
  });
});
