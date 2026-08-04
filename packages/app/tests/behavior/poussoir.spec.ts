import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { PoussoirService, jourMontreal, parseFile } from '@/services/poussoir/poussoir';
import type { Notification, NotifyPusher } from '@/services/notify/notifier';

/**
 * Poussoir: one prepared gesture a day, an evening relance when dodged, a
 * streak that only self-report can feed but that a skip always resets.
 * Day math is America/Montreal: Darius acts in the EASTERN evening, and a
 * UTC boundary would break an honest streak (20:00 ET = 00:00 UTC the day
 * after).
 */

class NotifierEspion implements NotifyPusher {
  pushed: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushed.push(n);
  }
}

const FILE_2_GESTES = `---
type: systeme
---

# Poussoir

## Poster le fil LinkedIn sur le bug published_at

Texte prêt :
10 jours pour trouver un bug qui n'existait pas dans mon code...

## Soumettre qrstudio.agency à 3 annuaires

Liste : ...
`;

// 15:00 UTC = 11:00 à Montréal (été) : après l'envoi du matin.
const MATIN = new Date('2026-08-04T15:00:00Z');
// 00:30 UTC le 5 = 20:30 à Montréal le 4 : l'heure des comptes.
const SOIR = new Date('2026-08-05T00:30:00Z');

function fabrique(opts: {
  fichiers?: Record<string, string>;
  now?: Date;
  notify?: NotifierEspion;
}) {
  const vault = new InMemoryVaultManager(opts.fichiers ?? { '08-auto/_poussoir.md': FILE_2_GESTES });
  const notify = opts.notify ?? new NotifierEspion();
  const service = new PoussoirService({
    vault,
    notify,
    baseUrl: 'https://cerveau.example',
    token: 'jeton',
    now: () => opts.now ?? MATIN,
  });
  return { vault, notify, service };
}

describe('Poussoir : la file', () => {
  it('le geste courant est la première section non consommée', () => {
    const { courant, gestes } = parseFile(FILE_2_GESTES);
    expect(gestes).toHaveLength(2);
    expect(courant?.titre).toContain('LinkedIn');
  });

  it('une section marquée Fait est consommée, la suivante prend la place', () => {
    const consomme = FILE_2_GESTES.replace(
      'Texte prêt :',
      '**Fait le 2026-08-03.**\n\nTexte prêt :',
    );
    const { courant } = parseFile(consomme);
    expect(courant?.titre).toContain('annuaires');
  });

  it('jourMontreal met la soirée de l’Est dans le BON jour', () => {
    // 00:30 UTC le 5 août = encore le 4 août à Montréal.
    expect(jourMontreal(SOIR)).toBe('2026-08-04');
  });
});

describe('Poussoir : envoi du matin', () => {
  it('pousse LE geste, pas une liste, avec le lien one-tap', async () => {
    const { notify, service } = fabrique({});
    const r = await service.envoiMatin();
    expect(r.envoye).toBe(true);
    expect(notify.pushed).toHaveLength(1);
    const n = notify.pushed[0];
    expect(n.title).toContain('série 0');
    expect(n.message).toContain('LinkedIn');
    expect(n.message).not.toContain('annuaires'); // un seul geste à la fois
    expect(n.click).toContain('/poussoir?k=jeton');
  });

  it('file vide : un signal doux, une seule fois par jour', async () => {
    const { notify, service } = fabrique({ fichiers: {} });
    await service.envoiMatin();
    await service.envoiMatin();
    expect(notify.pushed).toHaveLength(1);
    expect(notify.pushed[0].title).toContain('à sec');
  });

  it('un jour raté se dit en face : série perdue', async () => {
    const { notify, service } = fabrique({
      fichiers: {
        '08-auto/_poussoir.md': FILE_2_GESTES,
        '08-auto/_poussoir-state.json': JSON.stringify({
          version: 1,
          serie: 6,
          dernierFait: '2026-08-01', // il y a 3 jours : trou
          dernierEnvoi: null,
          derniereRelance: null,
          dernierVide: null,
        }),
      },
    });
    await service.envoiMatin();
    expect(notify.pushed[0].title).toContain('série perdue (était 6)');
  });
});

describe('Poussoir : relance du soir', () => {
  it('pas fait ce soir-là : relance priorité 5, série en jeu', async () => {
    const { vault, notify, service } = fabrique({});
    await service.envoiMatin();
    notify.pushed.length = 0;
    const soir = new PoussoirService({
      vault,
      notify,
      baseUrl: 'https://cerveau.example',
      token: 'jeton',
      now: () => SOIR,
    });
    const r = await soir.relanceSoir();
    expect(r.relance).toBe(true);
    expect(notify.pushed[0].priority).toBe(5);
    expect(notify.pushed[0].message).toContain('Série en jeu');
  });

  it('fait dans la journée : aucune relance', async () => {
    const { vault, notify, service } = fabrique({});
    await service.envoiMatin();
    await service.fait();
    notify.pushed.length = 0;
    const soir = new PoussoirService({
      vault,
      notify,
      now: () => SOIR,
    });
    const r = await soir.relanceSoir();
    expect(r.relance).toBe(false);
    expect(notify.pushed).toEqual([]);
  });

  it('apres un Passer explicite, le soir se TAIT : Darius a deja repondu', async () => {
    const { vault, notify, service } = fabrique({});
    await service.envoiMatin();
    await service.passe(); // il a paye : serie a zero
    notify.pushed.length = 0;
    const soir = new PoussoirService({
      vault,
      notify,
      now: () => SOIR,
    });
    const r = await soir.relanceSoir();
    expect(r.relance).toBe(false);
    expect(notify.pushed).toEqual([]);
  });

  it('sans envoi du matin, le soir se tait (pas de harcèlement orphelin)', async () => {
    const { service } = fabrique({ now: SOIR });
    const r = await service.relanceSoir();
    expect(r.relance).toBe(false);
  });
});

describe('Poussoir : fait et passer', () => {
  it('fait : consomme le geste, écrit la marque visible, série +1', async () => {
    const { vault, service } = fabrique({});
    const r = await service.fait();
    expect(r.ok).toBe(true);
    expect(r.serie).toBe(1);
    const contenu = await vault.readFile('08-auto/_poussoir.md');
    expect(contenu).toContain(`**Fait le ${jourMontreal(MATIN)}.**`);
    const { courant } = parseFile(contenu);
    expect(courant?.titre).toContain('annuaires');
  });

  it('deux jours consécutifs (heure de Montréal) : la série grandit', async () => {
    const { vault, service } = fabrique({});
    await service.fait(); // le 4, série 1
    const lendemainSoir = new PoussoirService({
      vault,
      // 01:00 UTC le 6 = le 5 au soir à Montréal : jour consécutif.
      now: () => new Date('2026-08-06T01:00:00Z'),
    });
    const r = await lendemainSoir.fait();
    expect(r.serie).toBe(2);
  });

  it('un trou d’un jour : la série repart à 1', async () => {
    const { vault, service } = fabrique({});
    await service.fait();
    const troisJoursApres = new PoussoirService({
      vault,
      now: () => new Date('2026-08-07T15:00:00Z'),
    });
    const r = await troisJoursApres.fait();
    expect(r.serie).toBe(1);
  });

  it('passer : consomme SANS crédit et remet la série à zéro', async () => {
    const { vault, service } = fabrique({
      fichiers: {
        '08-auto/_poussoir.md': FILE_2_GESTES,
        '08-auto/_poussoir-state.json': JSON.stringify({
          version: 1,
          serie: 4,
          dernierFait: '2026-08-03',
          dernierEnvoi: null,
          derniereRelance: null,
          dernierVide: null,
        }),
      },
    });
    const r = await service.passe();
    expect(r.ok).toBe(true);
    const contenu = await vault.readFile('08-auto/_poussoir.md');
    expect(contenu).toContain('**Passé le');
    const etat = JSON.parse(await vault.readFile('08-auto/_poussoir-state.json')) as {
      serie: number;
    };
    expect(etat.serie).toBe(0);
  });

  it('double tap sur Fait le meme jour : le second est refuse, le geste de demain survit', async () => {
    const { vault, service } = fabrique({});
    const r1 = await service.fait();
    expect(r1.ok).toBe(true);
    const r2 = await service.fait(); // onglet restaure par Chrome, F5, double tap
    expect(r2.ok).toBe(false);
    expect(r2.dejaTraite).toBe(true);
    const { gestes } = parseFile(await vault.readFile('08-auto/_poussoir.md'));
    const consommes = gestes.filter(g => /\*\*(Fait|Passé) le /.test(g.corps));
    expect(consommes).toHaveLength(1); // UN seul geste consomme
  });

  it('fait apres un Passer le meme jour : refuse aussi (un traitement par jour)', async () => {
    const { service } = fabrique({});
    await service.passe();
    const r = await service.fait();
    expect(r.ok).toBe(false);
    expect(r.dejaTraite).toBe(true);
  });

  it('file vide : fait et passer répondent sans casser', async () => {
    const { service } = fabrique({ fichiers: {} });
    expect((await service.fait()).ok).toBe(false);
    expect((await service.passe()).ok).toBe(false);
  });
});
