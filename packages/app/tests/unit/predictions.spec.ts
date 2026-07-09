import { describe, it, expect } from 'vitest';
import { isNearDuplicate, addPrediction, type PredictionBook } from '@/services/reflection/predictions';

const emptyBook = (): PredictionBook => ({ open: [], resolved: [], updated: '' });

describe('isNearDuplicate', () => {
  it('catches paraphrases of the same bet (the 5-identical-bets bug)', () => {
    expect(
      isNearDuplicate(
        "L'email marchand #289 sera envoyé avant le 10 juillet",
        "Darius aura envoyé l'email #289 au marchand",
      ),
    ).toBe(true);
  });

  it('accents and punctuation do not defeat it', () => {
    expect(isNearDuplicate('Créer la fiche Laura Panas', 'creer fiche laura panas!')).toBe(true);
  });

  it('genuinely different bets pass', () => {
    expect(
      isNearDuplicate(
        "L'email marchand #289 sera envoyé",
        'Le pilote QRStudio AR sera vendu à un restaurant',
      ),
    ).toBe(false);
  });
});

describe('addPrediction near-dup gate', () => {
  it('rejects a reformulated duplicate of an open bet', () => {
    const book = emptyBook();
    const first = addPrediction(
      book,
      { statement: "L'email marchand #289 sera envoyé", expectedBy: '2099-01-05', confidence: 0.7 },
      'basis',
      '2099-01-01',
    );
    expect(first).not.toBeNull();
    const dup = addPrediction(
      book,
      { statement: "Darius aura envoyé l'email #289 au marchand", expectedBy: '2099-01-08', confidence: 0.8 },
      'basis',
      '2099-01-01',
    );
    expect(dup).toBeNull();
    expect(book.open).toHaveLength(1);
  });
});
