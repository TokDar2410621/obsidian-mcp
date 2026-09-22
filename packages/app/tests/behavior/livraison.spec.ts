import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { LivraisonService, estDemandeDeDarius } from '@/services/livraison/livraison';
import type { Notification, NotifyPusher } from '@/services/notify/notifier';

/**
 * Livraison : l'etape qui manquait entre « produit » et « Darius le sait ».
 *
 * Vecu le 2026-09-21 : tache donnee a 23h17, executee et controlee CONFORME a
 * 23h35, aucune notification. La seule annonce de livrable de la journee vient
 * du balayage de relance, qui exige un age d'un jour, trie du plus ancien au
 * plus recent et n'annonce que le premier : ce soir-la, une tache du 12
 * juillet, avec 81 autres derriere. Un travail reussi vite etait
 * structurellement inannoncable.
 */

class NotifierEspion implements NotifyPusher {
  pushed: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushed.push(n);
  }
}

function tache(opts: { statut?: string; source?: string; risque?: string; titre?: string }): string {
  return `---
type: tache
statut: ${opts.statut ?? 'a-valider'}
risque: ${opts.risque ?? 'sans-risque'}
source: ${opts.source ?? 'cerveau'}
created: 2026-09-21
---

# ${opts.titre ?? 'Une tache'}

## Demande
Peu importe.

## Résultat

**2026-09-21 19:31**

resume: Verdict ecrit, self-hebergement rejete, Google Workspace a 1 boite.
livrables: 05-projects/cerveau/decisions/2026-09-21-email-pro-verdict.md
`;
}

function fabrique(fichiers: Record<string, string>) {
  const vault = new InMemoryVaultManager(fichiers);
  const notify = new NotifierEspion();
  const service = new LivraisonService({
    vault,
    notify,
    baseUrl: 'https://cerveau.example',
    token: 'jeton',
  });
  return { vault, notify, service };
}

describe('Livraison : qui merite une notification', () => {
  it('reconnait ce que Darius a demande lui-meme', () => {
    for (const s of ['telephone', 'chat', 'darius', 'triage', 'revue', 'TELEPHONE']) {
      expect(estDemandeDeDarius(s)).toBe(true);
    }
  });

  it('traite les initiatives du cerveau, et les sources absentes, comme siennes', () => {
    for (const s of ['cerveau', 'penseur', 'sonde-produit', '', 'inconnu']) {
      expect(estDemandeDeDarius(s)).toBe(false);
    }
  });
});

describe('Livraison : le passage', () => {
  it('une tache demandee au telephone est annoncee TOUT DE SUITE, avec son livrable', async () => {
    const { vault, notify, service } = fabrique({
      '09-taches/a.md': tache({ source: 'telephone', titre: 'Trancher email pro' }),
    });
    const r = await service.run();
    expect(r.annoncees).toBe(1);
    expect(notify.pushed).toHaveLength(1);
    const n = notify.pushed[0];
    expect(n.title).toContain('Trancher email pro');
    expect(n.message).toContain('Google Workspace'); // le resume, pas un vide
    expect(n.message).toContain('2026-09-21-email-pro-verdict.md'); // le chemin du livrable
    expect(n.click).toContain('/revue?k=jeton');
    // Elle reste a valider : c'est Darius qui juge ce qu'il a demande.
    expect(await vault.readFile('09-taches/a.md')).toContain('statut: a-valider');
  });

  it('une initiative du cerveau se ferme seule, sans bruit', async () => {
    const { vault, notify, service } = fabrique({
      '09-taches/b.md': tache({ source: 'penseur' }),
    });
    const r = await service.run();
    expect(r.fermees).toBe(1);
    expect(notify.pushed).toEqual([]);
    expect(await vault.readFile('09-taches/b.md')).toContain('statut: validee');
  });

  it('une tache a validation requise n est JAMAIS fermee seule, meme venue du cerveau', async () => {
    // Si le geste valait un feu vert avant, son resultat vaut un regard apres.
    const { vault, notify, service } = fabrique({
      '09-taches/c.md': tache({ source: 'cerveau', risque: 'validation-requise' }),
    });
    const r = await service.run();
    expect(r.annoncees).toBe(1);
    expect(notify.pushed).toHaveLength(1);
    expect(await vault.readFile('09-taches/c.md')).toContain('statut: a-valider');
  });

  it('ne touche pas une tache qui n est pas terminee', async () => {
    const { notify, service } = fabrique({
      '09-taches/d.md': tache({ statut: 'en-cours', source: 'telephone' }),
      '09-taches/e.md': tache({ statut: 'proposee', source: 'telephone' }),
    });
    const r = await service.run();
    expect(r).toEqual({ annoncees: 0, fermees: 0 });
    expect(notify.pushed).toEqual([]);
  });

  it('ne repasse jamais deux fois sur la meme tache', async () => {
    const { notify, service } = fabrique({
      '09-taches/f.md': tache({ source: 'telephone' }),
    });
    await service.run();
    await service.run();
    await service.run();
    expect(notify.pushed).toHaveLength(1); // une seule annonce, pas trois
  });

  it('un lot mixte : chacun sa voie, en un seul passage', async () => {
    const { notify, service } = fabrique({
      '09-taches/g.md': tache({ source: 'telephone', titre: 'Demandee' }),
      '09-taches/h.md': tache({ source: 'cerveau' }),
      '09-taches/i.md': tache({ source: 'penseur' }),
      '09-taches/j.md': tache({ source: 'triage', titre: 'Capture triee' }),
    });
    const r = await service.run();
    expect(r).toEqual({ annoncees: 2, fermees: 2 });
    expect(notify.pushed.map(n => n.title).join(' ')).toContain('Demandee');
    expect(notify.pushed.map(n => n.title).join(' ')).toContain('Capture triee');
  });

  it('ignore les fichiers de service du repertoire', async () => {
    const { service } = fabrique({
      '09-taches/_HOWTO.md': tache({ source: 'telephone' }),
      '09-taches/_darius.md': tache({ source: 'telephone' }),
    });
    expect(await service.run()).toEqual({ annoncees: 0, fermees: 0 });
  });
});
