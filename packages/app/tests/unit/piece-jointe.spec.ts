import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  cheminServable,
  classerLivrables,
  construirePieceJointe,
  nomFichier,
  typeMime,
} from '@/services/livraison/piece-jointe';
import type { Signeur } from '@/services/livraison/lien-signe';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

/**
 * Choisir CE QUI vaut d etre montre. Tous les cas ci-dessous viennent du
 * coffre reel : `livrables:` n est pas une liste de fichiers, c est une ligne
 * de texte ecrite par un executeur.
 */

const signeurFactice: Signeur = chemin => ({
  brut: `https://c.example/livrable?f=${encodeURIComponent(chemin)}&e=1&s=sig`,
  vue: `https://c.example/livrable/vue?f=${encodeURIComponent(chemin)}&e=1&s=sig`,
});

describe('piece-jointe : le classement', () => {
  it('12. une image bat un markdown, quelle que soit sa position', () => {
    const l = ['fiche.md', 'transcript.md', '01-raw/images/img.jpg', '09-taches/x.md'];
    expect(classerLivrables(l, '09-taches/t.md')[0]).toBe('01-raw/images/img.jpg');
  });

  it('13. sans image, le PREMIER .md gagne, jamais la derniere entree', () => {
    // C etait le defaut : `livrables[livrables.length - 1]` est presque toujours
    // la fiche de la tache, c est-a-dire rien.
    const l = ['02-knowledge/produit.md', '01-raw/transcripts/brut.md', '09-taches/t.md'];
    expect(classerLivrables(l, '09-taches/t.md')).toEqual([
      '02-knowledge/produit.md',
      '01-raw/transcripts/brut.md',
    ]);
  });

  it('14. la tache seule ne donne aucun candidat, et la raison est aucun-servable', () => {
    const l = ['09-taches/2026-08-31-appliquer-ca-pour-gridar.md'];
    expect(classerLivrables(l, '09-taches/2026-08-31-appliquer-ca-pour-gridar.md')).toEqual([]);
    expect(construirePieceJointe(null, signeurFactice, l).raison).toBe('aucun-servable');
  });

  it('15. les entrees qui ne sont pas des fichiers sont ignorees', () => {
    for (const faux of [
      'commit 66e11b3',
      'commits 3e77042a, 9d135193',
      'C:/Users/Darius/Documents/demo-deploy/',
      '(journal + résultat)',
    ]) {
      expect(cheminServable(faux)).toBe(false);
    }
    expect(classerLivrables(['commit 66e11b3', 'a/b.png'], 't.md')).toEqual(['a/b.png']);
  });

  it('16. les chemins absolus Windows de l ere PC2 sont refuses', () => {
    expect(cheminServable('C:\\Users\\leroi\\Desktop\\mon-cerveau\\note.md')).toBe(false);
    expect(cheminServable('C:/Users/Darius/Desktop/cerveau/09-taches/x.md')).toBe(false);
    expect(cheminServable('/etc/passwd.md')).toBe(false);
    expect(cheminServable('../../secret.md')).toBe(false);
  });

  it('17. une URL ne devient jamais un attach', () => {
    expect(cheminServable('https://ar-fit-demo-abc.vercel.app/pdp')).toBe(false);
    expect(cheminServable('https://ar-fit-demo-abc.vercel.app/hero.png')).toBe(false);
  });

  it('18. une zone sensible est refusee ET le signeur n est JAMAIS appele', () => {
    const espion = vi.fn(signeurFactice);
    const sensible = '00-personnel/caq/imm5709-reponses-2026.md';
    expect(cheminServable(sensible)).toBe(false);
    expect(classerLivrables([sensible], 't.md')).toEqual([]);
    expect(construirePieceJointe(sensible, espion).raison).toBe('aucun-servable');
    expect(espion).toHaveBeenCalledTimes(0);
  });

  it('19. un chemin a ESPACES est accepte, la ou validNotePath le refuse', () => {
    const chemin = '05-projects/Projet 3D Web Animation/04-web-animation-patterns.md';
    expect(cheminServable(chemin)).toBe(true);
    expect(classerLivrables([chemin], 't.md')).toEqual([chemin]);
  });
});

describe('piece-jointe : la construction', () => {
  it('20. une image donne attach ET filename, et filename est le basename seul', () => {
    const p = construirePieceJointe('05-projects/publiar/visuel-indexation.png', signeurFactice);
    expect(p.attach).toContain('/livrable?f=');
    expect(p.filename).toBe('visuel-indexation.png');
    expect(p.filename).not.toContain('/');
    expect(p.click).toContain('/livrable/vue?f=');
    expect(nomFichier('a/b/c.png')).toBe('c.png');
  });

  it('21. un .md donne un click, et laisse attach indefini', () => {
    // ntfy pousserait un markdown comme blob a telecharger : ca ne montre rien.
    const p = construirePieceJointe('02-knowledge/note.md', signeurFactice);
    expect(p.attach).toBeUndefined();
    expect(p.click).toContain('/livrable/vue?f=');
    expect(p.chemin).toBe('02-knowledge/note.md');
  });

  it('22. sans signeur : ni attach ni click, et la raison le dit', () => {
    const p = construirePieceJointe('a/b.png', null);
    expect(p.attach).toBeUndefined();
    expect(p.click).toBeUndefined();
    expect(p.raison).toBe('signature-indisponible');
  });

  it('une tache sans aucun livrable se distingue d une tache sans livrable servable', () => {
    expect(construirePieceJointe(null, signeurFactice, []).raison).toBe('aucun-livrable');
    expect(construirePieceJointe(null, signeurFactice, ['commit abc']).raison).toBe(
      'aucun-servable',
    );
  });

  it('les types MIME servis sont ceux du fichier, pas une devinette', () => {
    expect(typeMime('a/b.png')).toBe('image/png');
    expect(typeMime('a/b.JPG')).toBe('image/jpeg');
    expect(typeMime('a/b.pdf')).toBe('application/pdf');
    expect(typeMime('a/b.html')).toBe('text/html');
    expect(typeMime('a/b.md')).toBe('text/markdown');
    expect(typeMime('a/b.py')).toContain('text/plain');
  });
});

/**
 * Le dernier metre du dernier metre. Le 2026-09-22 a 06h25 la premiere
 * livraison reelle a pousse `attach` vers une vraie image, et Darius a
 * repondu « c'est toujours un lien ». Pour une piece jointe externe ntfy ne
 * telecharge rien : le message publie portait « None » en type et en taille,
 * donc le client affiche un lien. Seul `icon` montre l'image.
 */
describe('Piece jointe : une image se MONTRE, elle ne se telecharge pas', () => {
  const signeur = (chemin: string) => ({
    brut: `https://x.test/livrable?f=${encodeURIComponent(chemin)}&e=9&s=sig`,
    vue: `https://x.test/livrable/vue?f=${encodeURIComponent(chemin)}&e=9&s=sig`,
  });

  it('un JPEG porte icon EN PLUS de attach', () => {
    const p = construirePieceJointe('01-raw/images/card-og-image.jpg', signeur);
    expect(p.attach).toContain('card-og-image.jpg');
    expect(p.icon).toBe(p.attach);
    expect(p.filename).toBe('card-og-image.jpg');
  });

  it('un PNG aussi', () => {
    expect(construirePieceJointe('01-raw/fichiers/preuve.png', signeur).icon).toBeTruthy();
  });

  it('un PDF reste attache SANS icon : ntfy ne rend que JPEG et PNG', () => {
    // Pas `01-raw/docs/` : c'est une zone sensible, la garde refuse et le test
    // mesurerait la garde au lieu de l'icone.
    const p = construirePieceJointe('05-projects/cerveau/preuves/rapport.pdf', signeur);
    expect(p.attach).toBeTruthy();
    expect(p.icon).toBeUndefined();
  });

  it('un html ou un md n ont ni attach ni icon, seulement la page de vue', () => {
    for (const f of ['05-projects/hero.html', '05-projects/note.md']) {
      const p = construirePieceJointe(f, signeur);
      expect(p.attach).toBeUndefined();
      expect(p.icon).toBeUndefined();
      expect(p.click).toContain('/livrable/vue');
    }
  });
});

/**
 * Les visuels rendus sur PC2 ne vivent QUE dans le bucket, jamais dans git.
 * Tant que `cheminServable` refusait les deux-points sans exception, aucune
 * cle `bucket:` n etait signee, et la branche du bucket de /livrable restait
 * du code mort. Darius, 2026-09-22 : « est-ce que je vais recevoir ces liens
 * dans le ntfy ? genre les liens du bucket ? » La reponse etait non.
 */
describe('Piece jointe : une cle de bucket est servable', () => {
  const signeur = (chemin: string) => ({
    brut: `https://x.test/livrable?f=${encodeURIComponent(chemin)}&e=9&s=sig`,
    vue: `https://x.test/livrable/vue?f=${encodeURIComponent(chemin)}&e=9&s=sig`,
  });

  it('une image du bucket est acceptee, signee, et porte son icone', () => {
    const cle = 'bucket:01-raw/fichiers/2026-09-22-0625-seo-aeo-geo-demo.png';
    expect(cheminServable(cle)).toBe(true);
    const p = construirePieceJointe(cle, signeur);
    expect(p.attach).toContain('bucket%3A');
    expect(p.icon).toBe(p.attach);
    expect(p.raison).toBeUndefined();
  });

  it('un lecteur Windows reste refuse : le deux-points garde son role', () => {
    expect(cheminServable('C:/Users/Darius/secret.png')).toBe(false);
    expect(cheminServable('bucket:C:/ailleurs.png')).toBe(false);
  });

  it('une zone sensible reste refusee MEME dans le bucket', () => {
    expect(cheminServable('bucket:00-personnel/carte.png')).toBe(false);
    expect(cheminServable('bucket:01-raw/docs/passeport.png')).toBe(false);
  });

  it('une traversee de chemin reste refusee', () => {
    expect(cheminServable('bucket:../../etc/passwd.png')).toBe(false);
  });
});
