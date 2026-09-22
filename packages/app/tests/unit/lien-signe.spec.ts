import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  creerSigneur,
  secretLivrable,
  signer,
  ttlSecondes,
  verifier,
} from '@/services/livraison/lien-signe';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

/**
 * Le lien signe : ce qui fait qu'un fichier du coffre arrive sur le telephone
 * sans que le CAPTURE_TOKEN sorte une fois de plus.
 */

const JETON = 'jeton-de-capture-123';

let sauvegarde: NodeJS.ProcessEnv;

beforeEach(() => {
  sauvegarde = { ...process.env };
  delete process.env.LIVRABLE_SECRET;
  delete process.env.LIVRAISON_LIEN_JOURS;
  process.env.CAPTURE_TOKEN = JETON;
});

afterEach(() => {
  process.env = sauvegarde;
});

describe('lien-signe : la signature', () => {
  it('1. signe un chemin, et sa propre signature est acceptee', () => {
    const l = signer('05-projects/x/hero.png');
    expect(l).not.toBeNull();
    expect(verifier(l!.f, l!.e, l!.s)).toBe('ok');
  });

  it('2. un chemin modifie d UN caractere devient invalide', () => {
    // Le chemin est DANS le message signe : une signature ne se rejoue jamais
    // sur un autre fichier.
    const l = signer('05-projects/x/hero.png')!;
    expect(verifier('05-projects/x/hera.png', l.e, l.s)).toBe('invalide');
  });

  it('3. une expiration passee rend expire, pas invalide', () => {
    // La route doit pouvoir repondre 410 et une page lisible, pas un refus sec.
    const hier = Date.now() - 8 * 86400 * 1000;
    const l = signer('05-projects/x/hero.png', hier)!;
    expect(verifier(l.f, l.e, l.s)).toBe('expire');
  });

  it('4. un digest de longueur differente rend invalide SANS lever', () => {
    // timingSafeEqual leve sur deux buffers inegaux : la longueur se teste avant.
    const l = signer('a/b.png')!;
    expect(() => verifier(l.f, l.e, 'court')).not.toThrow();
    expect(verifier(l.f, l.e, 'court')).toBe('invalide');
  });

  it('5. deux CAPTURE_TOKEN differents donnent deux digests differents', () => {
    const a = signer('a/b.png', 1_700_000_000_000, { CAPTURE_TOKEN: 'un' } as NodeJS.ProcessEnv)!;
    const b = signer('a/b.png', 1_700_000_000_000, { CAPTURE_TOKEN: 'deux' } as NodeJS.ProcessEnv)!;
    expect(a.e).toBe(b.e);
    expect(a.s).not.toBe(b.s);
  });

  it('6. le meme jeton et la meme expiration donnent le MEME digest', () => {
    // Railway redeploie souvent : un secret tire au hasard au boot tuerait
    // toutes les pieces jointes deja envoyees.
    const a = signer('a/b.png', 1_700_000_000_000)!;
    const b = signer('a/b.png', 1_700_000_000_000)!;
    expect(a.s).toBe(b.s);
    expect(secretLivrable()).not.toBeNull();
  });

  it('7. LIVRABLE_SECRET prend le pas sur la derivation du CAPTURE_TOKEN', () => {
    const derive = signer('a/b.png', 1_700_000_000_000)!;
    process.env.LIVRABLE_SECRET = 'une-clef-a-part';
    const dedie = signer('a/b.png', 1_700_000_000_000)!;
    expect(dedie.s).not.toBe(derive.s);
  });

  it('8. sans aucun secret, signer rend null et verifier rend desactive', () => {
    delete process.env.CAPTURE_TOKEN;
    expect(secretLivrable()).toBeNull();
    expect(signer('a/b.png')).toBeNull();
    expect(verifier('a/b.png', 123, 'peu-importe')).toBe('desactive');
    expect(creerSigneur('https://cerveau.example')).toBeNull();
  });
});

describe('lien-signe : les URL', () => {
  it('9. l URL porte f, e, s et JAMAIS la valeur du CAPTURE_TOKEN', () => {
    const s = creerSigneur('https://cerveau.example')!;
    const lien = s('05-projects/x/hero.png')!;
    for (const url of [lien.brut, lien.vue]) {
      expect(url).toContain('f=');
      expect(url).toContain('e=');
      expect(url).toContain('s=');
      expect(url).not.toContain(JETON);
    }
    expect(lien.brut).toContain('/livrable?');
    expect(lien.vue).toContain('/livrable/vue?');
  });

  it('10. un baseUrl termine par / ne produit jamais //livrable', () => {
    const s = creerSigneur('https://cerveau.example/')!;
    const lien = s('a/b.png')!;
    expect(lien.brut).toContain('https://cerveau.example/livrable?');
    expect(lien.brut).not.toContain('//livrable');
  });

  it('11. un chemin a espaces est encode et redonne le chemin exact', () => {
    const chemin = '05-projects/Projet 3D Web Animation/04-patterns.md';
    const s = creerSigneur('https://cerveau.example')!;
    const lien = s(chemin)!;
    const f = new URL(lien.vue).searchParams.get('f');
    expect(f).toBe(chemin);
    expect(lien.vue).not.toContain(' ');
  });

  it('une zone sensible n est JAMAIS signee', () => {
    // Un lien signe vers une piece d identite survit hors de toute fenetre de
    // deverrouillage, et sur ntfy.sh public le fichier transite par un tiers.
    expect(signer('00-personnel/caq/imm5709-reponses-2026.md')).toBeNull();
    const s = creerSigneur('https://cerveau.example')!;
    expect(s('00-personnel/caq/imm5709-reponses-2026.md')).toBeNull();
  });

  it('la duree de vie se compte en jours, sept par defaut', () => {
    expect(ttlSecondes()).toBe(7 * 86400);
    expect(ttlSecondes({ LIVRAISON_LIEN_JOURS: '2' } as NodeJS.ProcessEnv)).toBe(2 * 86400);
    expect(ttlSecondes({ LIVRAISON_LIEN_JOURS: 'nimporte' } as NodeJS.ProcessEnv)).toBe(7 * 86400);
  });
});
