import { describe, it, expect } from 'vitest';
import { filtrerPertinents, estAncree } from '@/services/rag/rag-service';
import { REFUS_HORS_CERVEAU } from '@/services/rag/generator';

// « Je veux que les réponses de l'interface graphique proviennent juste du
// cerveau » (Darius, 2026-07-13). Deux verrous purs, testés à sec.

describe('filtrerPertinents (plancher de pertinence avant génération)', () => {
  const hits = [
    { score: 0.62, id: 'a' },
    { score: 0.31, id: 'b' },
    { score: 0.12, id: 'c' },
  ];

  it('coupe les extraits hors sujet sous le plancher', () => {
    expect(filtrerPertinents(hits, 0.25).map(h => h.id)).toEqual(['a', 'b']);
  });

  it('peut ne rien laisser passer : la branche refus redevient vivante', () => {
    expect(filtrerPertinents(hits, 0.9)).toEqual([]);
  });

  it('préserve l ordre du classement', () => {
    expect(filtrerPertinents(hits, 0).map(h => h.id)).toEqual(['a', 'b', 'c']);
  });
});

describe("estAncree (une réponse sans citation n'est pas du cerveau)", () => {
  const notes = ['feature-3d-ar', 'playbook-offre'];

  it('accepte une réponse qui cite une note fournie', () => {
    expect(estAncree('Le backend existe déjà ([[feature-3d-ar]]).', notes)).toBe(true);
  });

  it('tolère alias et ancres de heading', () => {
    expect(estAncree('Voir [[playbook-offre|le playbook]].', notes)).toBe(true);
    expect(estAncree('Voir [[feature-3d-ar#Pricing]].', notes)).toBe(true);
    expect(estAncree('voir [[FEATURE-3D-AR]]', notes)).toBe(true);
  });

  it('rejette une réponse sans aucune citation (savoir général déguisé)', () => {
    expect(estAncree('Le marketing repose sur la perception des clients.', notes)).toBe(false);
  });

  it('rejette une réponse qui ne cite que des notes inventées', () => {
    expect(estAncree('Comme le dit [[note-inventee]].', notes)).toBe(false);
  });

  it('laisse passer le refus explicite (avec ou sans la phrase exacte)', () => {
    expect(estAncree(REFUS_HORS_CERVEAU, notes)).toBe(true);
    expect(estAncree('Je ne trouve rien là-dessus dans tes notes.', notes)).toBe(true);
  });

  it('rejette le vide', () => {
    expect(estAncree('   ', notes)).toBe(false);
  });
});
