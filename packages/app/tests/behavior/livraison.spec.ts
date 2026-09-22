import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { LivraisonService, acheminer, estDemandeDeDarius } from '@/services/livraison/livraison';
import { ETAT_LIVRAISON, lireEtat } from '@/services/livraison/etat';
import type { Signeur } from '@/services/livraison/lien-signe';
import type { Notification, NotifyPusher } from '@/services/notify/notifier';
import { reprendreApresReponse } from '@/services/livraison/question';
import {
  CHEMIN_2026_07_12,
  CHEMIN_2026_08_31,
  FICHIER_2026_07_12,
  FICHIER_2026_08_31,
} from '@tests/support/fixtures/taches-bloquees.js';

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

/**
 * L etat est DEJA amorce : ces tests-la observent un passage qui AGIT.
 * Le tout premier passage, lui, n agit sur rien et se contente d inscrire
 * (voir « l amorcage » plus bas) : sans cette amorce prealable, la mise en
 * service enverrait neuf pushes et vingt-cinq commits en rafale.
 */
function fabrique(fichiers: Record<string, string>) {
  const vault = new InMemoryVaultManager({
    '08-auto/_livraison-state.json': JSON.stringify({
      version: 1,
      traitees: { '09-taches/_amorce.md': { le: '2026-09-01', voie: 'fermer' } },
    }),
    ...fichiers,
  });
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
    expect(r).toEqual({ annoncees: 0, fermees: 0, amorcees: 0, questions: 0 });
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
    expect(r).toEqual({ annoncees: 2, fermees: 2, amorcees: 0, questions: 0 });
    expect(notify.pushed.map(n => n.title).join(' ')).toContain('Demandee');
    expect(notify.pushed.map(n => n.title).join(' ')).toContain('Capture triee');
  });

  it('ignore les fichiers de service du repertoire', async () => {
    const { service } = fabrique({
      '09-taches/_HOWTO.md': tache({ source: 'telephone' }),
      '09-taches/_darius.md': tache({ source: 'telephone' }),
    });
    expect(await service.run()).toEqual({ annoncees: 0, fermees: 0, amorcees: 0, questions: 0 });
  });
});

// --- le livrable ARRIVE, il n est plus seulement nomme -----------------------

/**
 * Le second defaut, verbatim de Darius : « je n ai jamais recu le hero pour
 * voir physiquement », « je n ai jamais recu l affiche qui a ete refaite ».
 * Sept taches faites, controlees, dont le produit n a jamais atteint son
 * telephone. La notification portait le CHEMIN ; elle doit porter le FICHIER.
 */

const signeurFactice: Signeur = chemin => ({
  brut: `https://cerveau.example/livrable?f=${encodeURIComponent(chemin)}&e=9&s=sig`,
  vue: `https://cerveau.example/livrable/vue?f=${encodeURIComponent(chemin)}&e=9&s=sig`,
});

/** Une tache complete, avec la ligne `livrables:` exacte voulue par le test. */
function tacheAvec(opts: {
  source?: string;
  titre?: string;
  livrables?: string;
  created?: string;
}): string {
  return `---
type: tache
statut: a-valider
risque: sans-risque
source: ${opts.source ?? 'telephone'}
created: ${opts.created ?? '2026-09-21'}
---

# ${opts.titre ?? 'Une tache'}

## Demande
Peu importe.

## Résultat

**2026-09-21 19:31**

resume: Le hero est construit.
livrables: ${opts.livrables ?? '05-projects/x/hero.png'}
`;
}

/** Un etat deja amorce : le passage agit, au lieu de simplement inscrire. */
const ETAT_AMORCE = JSON.stringify({
  version: 1,
  traitees: { '09-taches/deja-vue.md': { le: '2026-09-01', voie: 'fermer' } },
});

function fabriqueSignee(
  fichiers: Record<string, string>,
  options: Partial<{ baseUrl: string; signeur: Signeur | null }> = {},
) {
  const vault = new InMemoryVaultManager(fichiers);
  const notify = new NotifierEspion();
  const service = new LivraisonService({
    vault,
    notify,
    baseUrl: 'https://cerveau.example',
    token: 'jeton',
    signeur: signeurFactice,
    ...options,
  });
  return { vault, notify, service };
}

describe("Livraison : l'amorcage, pour que la mise en service ne parte pas en rafale", () => {
  it('34. le tout premier passage inscrit tout et n agit sur RIEN', async () => {
    // Mesure sur le coffre a l instant T : un etat vide face aux 34 taches
    // a-valider donnait 9 pushes d affilee et 25 commit+push en rafale.
    const fichiers: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      fichiers[`09-taches/t${i}.md`] = tacheAvec({ source: i < 3 ? 'telephone' : 'penseur' });
    }
    const { vault, notify, service } = fabriqueSignee(fichiers);
    const r = await service.run();

    expect(r).toEqual({ annoncees: 0, fermees: 0, amorcees: 5, questions: 0 });
    expect(notify.pushed).toEqual([]);
    for (let i = 0; i < 5; i++) {
      expect(await vault.readFile(`09-taches/t${i}.md`)).toContain('statut: a-valider');
    }
    const etat = await lireEtat(vault);
    expect(Object.keys(etat.traitees)).toHaveLength(5);
    expect(Object.values(etat.traitees).every(e => e.voie === 'amorce')).toBe(true);
  });

  it('35. une tache arrivee APRES l amorcage est bien annoncee', async () => {
    const { vault, notify, service } = fabriqueSignee({
      '09-taches/ancienne.md': tacheAvec({ source: 'telephone', titre: 'Ancienne' }),
    });
    await service.run();
    expect(notify.pushed).toEqual([]);

    await vault.writeFile(
      '09-taches/fraiche.md',
      tacheAvec({ source: 'telephone', titre: 'Fraiche' }),
    );
    const r = await service.run();
    expect(r.annoncees).toBe(1);
    expect(notify.pushed[0].title).toContain('Fraiche');
  });

  it('36. le champ « le » d une amorce vaut le created: de la fiche', async () => {
    // La tache du garant du 12 juillet porte source: reponses, hors des
    // demandes de Darius : sans amorcage elle serait fermee en silence.
    const { vault, service } = fabriqueSignee({
      '09-taches/garant.md': tacheAvec({ source: 'reponses', created: '2026-07-12' }),
    });
    await service.run();
    const etat = await lireEtat(vault);
    expect(etat.traitees['09-taches/garant.md']).toEqual({ le: '2026-07-12', voie: 'amorce' });
    expect(await vault.readFile('09-taches/garant.md')).toContain('statut: a-valider');
  });
});

describe('Livraison : le livrable arrive physiquement', () => {
  it('37. un PNG existant devient un attach signe, avec son nom', async () => {
    const { notify, service } = fabriqueSignee({
      [ETAT_LIVRAISON]: ETAT_AMORCE,
      '09-taches/hero.md': tacheAvec({
        source: 'telephone',
        titre: 'Construire le hero',
        livrables: '05-projects/x/hero.png | 09-taches/hero.md',
      }),
      '05-projects/x/hero.png': 'des-octets-de-png',
    });
    await service.run();

    expect(notify.pushed).toHaveLength(1);
    const n = notify.pushed[0];
    expect(n.attach).toContain('/livrable?f=');
    expect(n.attach).toContain(encodeURIComponent('05-projects/x/hero.png'));
    expect(n.filename).toBe('hero.png');
    expect(n.click).toContain('/livrable/vue?f=');
    // Le nom reste dans le message : _notifications.md est la memoire des pushes.
    expect(n.message).toContain('hero.png');
  });

  it('un livrable ABSENT du coffre n est jamais signe, et le repli reste /revue', async () => {
    // Onze images seulement sont suivies par git : un attach vers un fichier
    // absent du clone du serveur donnerait une vignette morte.
    const { notify, service } = fabriqueSignee({
      [ETAT_LIVRAISON]: ETAT_AMORCE,
      '09-taches/x.md': tacheAvec({ livrables: '05-projects/x/jamais-commite.png' }),
    });
    await service.run();
    const n = notify.pushed[0];
    expect(n.attach).toBeUndefined();
    expect(n.click).toContain('/revue?k=jeton');
    expect(n.message).toContain('jamais-commite.png');
  });

  it('38. vingt taches fraiches ne font pas vingt vibrations', async () => {
    const fichiers: Record<string, string> = { [ETAT_LIVRAISON]: ETAT_AMORCE };
    for (let i = 0; i < 20; i++) {
      fichiers[`09-taches/r${i}.md`] = tacheAvec({ source: 'telephone', titre: `T${i}` });
    }
    const { notify, service } = fabriqueSignee(fichiers);

    const un = await service.run();
    expect(un.annoncees).toBe(3);
    expect(notify.pushed).toHaveLength(3);

    const deux = await service.run();
    expect(deux.annoncees).toBe(3);
    // Rien n est perdu : les suivantes repassent au tick d apres.
    expect(notify.pushed).toHaveLength(6);
    expect(new Set(notify.pushed.map(n => n.title)).size).toBe(6);
  });

  it('39. un etat au format legacy (tableau) est lu sans rien reannoncer', async () => {
    const { notify, service } = fabriqueSignee({
      [ETAT_LIVRAISON]: JSON.stringify({ version: 1, traitees: ['09-taches/vieille.md'] }),
      '09-taches/vieille.md': tacheAvec({ source: 'telephone', titre: 'Vieille' }),
    });
    const r = await service.run();
    expect(r).toEqual({ annoncees: 0, fermees: 0, amorcees: 0, questions: 0 });
    expect(notify.pushed).toEqual([]);
  });

  it('40. acheminer est la couture : deux voies aujourd hui, nommees', () => {
    const base = { path: 'p', titre: 't', resume: '', livrables: [], creee: '', resultatBrut: '' };
    expect(acheminer({ ...base, source: 'telephone', risque: 'sans-risque' })).toBe('annoncer');
    expect(acheminer({ ...base, source: 'cerveau', risque: 'validation-requise' })).toBe('annoncer');
    expect(acheminer({ ...base, source: 'penseur', risque: 'sans-risque' })).toBe('fermer');
  });

  it('41. un baseUrl termine par / ne produit jamais //revue', async () => {
    const { notify, service } = fabriqueSignee(
      {
        [ETAT_LIVRAISON]: ETAT_AMORCE,
        '09-taches/x.md': tacheAvec({ livrables: 'commit 66e11b3' }),
      },
      { baseUrl: 'https://cerveau.example/', signeur: null },
    );
    await service.run();
    expect(notify.pushed[0].click).toBe('https://cerveau.example/revue?k=jeton');
  });

  it('42. un push qui leve ne marque pas la tache, elle repasse au tour suivant', async () => {
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: ETAT_AMORCE,
      '09-taches/x.md': tacheAvec({ source: 'telephone', titre: 'Fragile' }),
    });
    const recus: Notification[] = [];
    let premier = true;
    const notify: NotifyPusher = {
      async push(n: Notification): Promise<void> {
        if (premier) {
          premier = false;
          throw new Error('ntfy injoignable');
        }
        recus.push(n);
      },
    };
    const service = new LivraisonService({
      vault,
      notify,
      baseUrl: 'https://c.example',
      token: 'j',
    });

    expect(await service.run()).toEqual({ annoncees: 0, fermees: 0, amorcees: 0, questions: 0 });
    const r = await service.run();
    expect(r.annoncees).toBe(1);
    expect(recus).toHaveLength(1);
  });

  it('43. les boutons Valider, Rejeter, Revue vivent dans actions, pas dans la page', async () => {
    // C est ce qui libere `click` pour le livrable sans faire entrer le
    // CAPTURE_TOKEN dans une page servie.
    const { notify, service } = fabriqueSignee({
      [ETAT_LIVRAISON]: ETAT_AMORCE,
      '09-taches/decision.md': tacheAvec({ source: 'telephone' }),
      '05-projects/x/hero.png': 'octets',
    });
    await service.run();
    const n = notify.pushed[0];
    expect(n.actions?.map(a => a.label)).toEqual(['Valider', 'Rejeter', 'Revue']);
    expect(n.actions?.[0].url).toContain('/valide?k=jeton&t=');
    expect(n.actions?.[0].url).toContain(encodeURIComponent('09-taches/decision.md'));
    expect(n.actions?.[1].url).toContain('/rejette?k=jeton&t=');
    expect(n.actions?.[2].url).toContain('/revue?k=jeton');
    // Le corps de la notif, lui, ouvre le LIVRABLE.
    expect(n.click).toContain('/livrable/vue?f=');
  });
});

// --- « impossible » n'est plus un livrable ------------------------------------

/**
 * Le troisieme defaut, verbatim de Darius : « quand je recois ca, impossible,
 * lien verrouille, aucun contenu capte, je dois faire quoi avec ? je dois
 * valider pour ne plus le voir ? ».
 *
 * Ces tests tournent sur les DEUX fiches reelles du coffre, pas sur des
 * exemples propres. Elles sont la mesure : l'une est arrivee en notification
 * « Termine » avec pour livrable son propre fichier de tache, l'autre se
 * serait fermee toute seule en `validee` parce que sa source est `cerveau`.
 */

function fabriqueQuestion(fichiers: Record<string, string>, amorce = true) {
  const vault = new InMemoryVaultManager({
    ...(amorce ? { [ETAT_LIVRAISON]: ETAT_AMORCE } : {}),
    ...fichiers,
  });
  const notify = new NotifierEspion();
  const service = new LivraisonService({
    vault,
    notify,
    baseUrl: 'https://cerveau.example',
    token: 'jeton',
    signeur: signeurFactice,
  });
  return { vault, notify, service };
}

describe('Livraison : une impossibilite revient en question, pas en livrable', () => {
  it('44. la fiche du 31 aout n est plus annoncee comme un livrable', async () => {
    const { notify, service } = fabriqueQuestion({
      [CHEMIN_2026_08_31]: FICHIER_2026_08_31,
    });
    const r = await service.run();
    expect(r.annoncees).toBe(0);
    expect(r.questions).toBe(1);
    expect(notify.pushed).toHaveLength(1);
  });

  it('45. elle prend le statut question-posee dans le coffre', async () => {
    const { vault, service } = fabriqueQuestion({
      [CHEMIN_2026_08_31]: FICHIER_2026_08_31,
    });
    await service.run();
    expect(await vault.readFile(CHEMIN_2026_08_31)).toContain('statut: question-posee');
    expect(await vault.readFile(CHEMIN_2026_08_31)).not.toContain('statut: a-valider');
  });

  it('46. la notification porte la question que l executeur avait deja ecrite', async () => {
    const { notify, service } = fabriqueQuestion({
      [CHEMIN_2026_08_31]: FICHIER_2026_08_31,
    });
    await service.run();
    const n = notify.pushed[0];
    expect(n.title).toContain('Il me manque');
    expect(n.message).toContain('quelle est la méthode ou le format montré dans la vidéo');
    expect(n.message).not.toContain('Le livrable est prêt');
    expect(n.message).not.toContain('Valider garde, Rejeter jette.');
    // Le bouton primaire ouvre la dictee, jamais /valide.
    expect(n.click).toContain('/capture/app?k=jeton&prefill=');
    expect(n.actions?.map(a => a.label)).not.toContain('Valider');
  });

  it('47. la fiche du 12 juillet n est PAS fermee en silence, malgre source: cerveau', async () => {
    // Sans la voie question posee AVANT le test de source, cette tache-la
    // devenait `validee` sans un mot : une impossibilite classee reussite.
    const { vault, notify, service } = fabriqueQuestion({
      [CHEMIN_2026_07_12]: FICHIER_2026_07_12,
    });
    const r = await service.run();
    expect(r.fermees).toBe(0);
    expect(r.questions).toBe(1);
    expect(await vault.readFile(CHEMIN_2026_07_12)).toContain('statut: question-posee');
    expect(notify.pushed[0].message).toContain("pour capturer le message d'erreur exact");
  });

  it('48. la voie question est evaluee AVANT le test de source', async () => {
    const bloquee = {
      path: 'p',
      titre: 't',
      resume: 'bloque',
      livrables: [],
      creee: '',
      resultatBrut: 'criteres: demande satisfaite=KO acces bloque',
    };
    for (const source of ['telephone', 'cerveau', 'penseur', 'reponses', '']) {
      expect(acheminer({ ...bloquee, source, risque: 'sans-risque' })).toBe('question');
    }
    // Y compris quand elle demandait une validation prealable.
    expect(acheminer({ ...bloquee, source: 'cerveau', risque: 'validation-requise' })).toBe(
      'question',
    );
  });

  it('49. trois passages d affilee ne posent la question qu UNE fois', async () => {
    const { notify, service } = fabriqueQuestion({
      [CHEMIN_2026_08_31]: FICHIER_2026_08_31,
    });
    await service.run();
    await service.run();
    await service.run();
    expect(notify.pushed).toHaveLength(1);
  });

  it('50. une tache saine reste annoncee comme avant', async () => {
    const { vault, notify, service } = fabriqueQuestion({
      '09-taches/saine.md': tacheAvec({ source: 'telephone', titre: 'Saine' }),
      '05-projects/x/hero.png': 'octets',
    });
    const r = await service.run();
    expect(r).toEqual({ annoncees: 1, fermees: 0, amorcees: 0, questions: 0 });
    expect(notify.pushed[0].title).toContain('✅ Terminé');
    expect(await vault.readFile('09-taches/saine.md')).toContain('statut: a-valider');
  });

  it('51. le tout premier passage amorce le reste, mais POSE les questions', async () => {
    // L'amorcage existe pour eviter une rafale sur l'historique, pas pour
    // enterrer les deux impossibilites que ce chantier repare.
    const { vault, notify, service } = fabriqueQuestion(
      {
        [CHEMIN_2026_08_31]: FICHIER_2026_08_31,
        [CHEMIN_2026_07_12]: FICHIER_2026_07_12,
        '09-taches/saine.md': tacheAvec({ source: 'telephone', titre: 'Saine' }),
      },
      false,
    );
    const r = await service.run();
    expect(r.questions).toBe(2);
    expect(r.annoncees).toBe(0);
    expect(r.fermees).toBe(0);
    expect(r.amorcees).toBe(1);
    expect(notify.pushed).toHaveLength(2);
    expect(await vault.readFile('09-taches/saine.md')).toContain('statut: a-valider');
    const etat = await lireEtat(vault);
    expect(etat.traitees[CHEMIN_2026_08_31].voie).toBe('question');
    expect(etat.traitees['09-taches/saine.md'].voie).toBe('amorce');
  });

  it('52. la reponse de Darius rattache la piece et relance la tache', async () => {
    const { vault, service } = fabriqueQuestion({
      [CHEMIN_2026_08_31]: FICHIER_2026_08_31,
    });
    await service.run();
    const ok = await reprendreApresReponse(
      vault,
      CHEMIN_2026_08_31,
      'la video montre un calendrier de questions client',
    );
    expect(ok).toBe(true);
    const fiche = await vault.readFile(CHEMIN_2026_08_31);
    expect(fiche).toContain('statut: proposee');
    const demande = fiche.slice(fiche.indexOf('## Demande'), fiche.indexOf('## Critères'));
    expect(demande).toContain('la video montre un calendrier de questions client');
  });
});
