import { describe, expect, it } from 'vitest';
import { masquerDonneesPersonnelles as m } from '@/services/invites/masquage';

/**
 * Le masquage de Dan (Q14, 2026-10-07). Les cas positifs reprennent les
 * FORMES trouvees par l'audit du coffre reel (valeurs inventees).
 */

describe('masque', () => {
  it.each([
    ['Écris à jean.tremblay@exemple.ca demain', 'jean.tremblay@exemple.ca'],
    ['Appelle le 418-555-0142 avant midi', '418-555-0142'],
    ['Tel : (581) 555 0199', '(581) 555 0199'],
    ['WhatsApp DK BOIS +237 6 94 46 99 29 réservé', '+237 6 94 46 99 29'],
    ['joindre +1 438 555 0177', '+1 438 555 0177'],
    ['Livrer au 1234 rue des Érables, Saguenay', '1234 rue des Érables'],
    ['Code postal G7H 5B1 confirmé', 'G7H 5B1'],
    ['permis etudes (F314509999), coop', 'F314509999'],
    ['Permis de travail coop no EB123456789 valide', 'EB123456789'],
    ['UCI : 1234-5678 à mettre', '1234-5678'],
    ['NAS 123 456 789 dans le formulaire', '123 456 789'],
    ['Lien https://meet.google.com/abc-defg-hij?pwd=x et voilà', 'meet.google.com/abc-defg-hij'],
    ['Passcode : Xy7kQ2 pour entrer', 'Xy7kQ2'],
    ['mot de passe : Tr0ub4dour&3', 'Tr0ub4dour&3'],
    ['Code de vérification Amazon : 281112', '281112'],
    ['clé sk-proj-AbCdEfGhIjKlMnOpQrStUvWx collée', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['remote https://x-access-token:ghp_FAUXFAUXFAUXFAUXFAUXFAUX@github.com/a/b', 'ghp_FAUXFAUXFAUXFAUXFAUXFAUX'],
    [
      '[Envoyer](mailto:x?body=Bonjour%2C%0A%0ADarius%20Tokam%0A418-555-0142%0ASaguenay%20%E2%80%93%20QC%20G7X%200M4%0A)',
      '418-555-0142',
    ],
  ])('%s', (texte, secret) => {
    const r = m(texte);
    expect(r).not.toContain(secret);
    expect(r).toMatch(/masqu/);
  });
});

describe('laisse intact', () => {
  it.each([
    'La réunion du 2026-10-07 à 14:05 a duré 45 minutes.',
    'Voir [[2026-07-22]] et 03-daily/2026-07-22.md pour le contexte.',
    'Vente de 4 300 $ le 19 juin, puis 135 $ CA par mois.',
    '1 945 notes indexées, 18 666 extraits, 3 568 commits.',
    "L'ami perd son mot de passe : réinitialisation par email.",
    'Le permis de construire est déjà obtenu.',
    'Version 6.4.1 de superpowers, Node 22, port 3000.',
    'Commit 99947a6 et id 0230c524-a54a-472a-a483-d12333d19f14.',
    'Objectif 10k mensuel, échéance 2027-06-30.',
  ])('%s', texte => {
    expect(m(texte)).toBe(texte);
  });
});
