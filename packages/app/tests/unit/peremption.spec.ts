import { afterEach, describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import type { Notification, NotifyPusher } from '@/services/notify/notifier';
import { ETAT_LIVRAISON, lireEtat } from '@/services/livraison/etat';
import {
  PeremptionService,
  archiver,
  dateDattente,
  estAValider,
  formaterDate,
  joursEntre,
  joursGrace,
  joursPeremption,
  ligneJournal,
  marquerEncoreUtile,
} from '@/services/livraison/peremption';

/**
 * Le defaut, verbatim : « si le cerveau fonctionnait, il aurait du se rendre
 * compte que la demande est terminee depuis longtemps, qu'il n'a plus besoin du
 * message du garant ».
 *
 * La tache
 * `09-taches/2026-07-12-r-diger-le-message-pr-t-envoyer-au-garant-pour-sa.md`
 * du coffre attend sa validation depuis le 12 juillet. Le balayage de relance
 * la reannonce tous les soirs parce qu'il trie du plus ancien au plus recent et
 * ne pousse que le premier. Le cas fondateur plus bas est sa copie conforme :
 * meme source, meme date de creation, meme horodatage de Resultat.
 */

const TOKEN = 'jeton';
const BASE = 'https://cerveau.example';
const GARANT = '09-taches/2026-07-12-r-diger-le-message-pr-t-envoyer-au-garant-pour-sa.md';

/**
 * Les deux tirets longs, construits par leur code plutot qu'ecrits en clair :
 * ce fichier doit rester exempt du caractere qu'il interdit, sans quoi le hook
 * git de Darius bloque le commit qui l'apporte.
 */
const TIRETS_LONGS = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

class NotifierEspion implements NotifyPusher {
  pushed: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushed.push(n);
  }
}

interface OptsTache {
  statut?: string;
  source?: string;
  created?: string;
  resultat?: string;
  titre?: string;
  resume?: string;
  journal?: boolean;
}

function tache(o: OptsTache = {}): string {
  return `---
type: tache
statut: ${o.statut ?? 'a-valider'}
risque: sans-risque
source: ${o.source ?? 'reponses'}
cible: vault
created: ${o.created ?? '2026-07-12'}
---

# ${o.titre ?? 'Rédiger le message prêt-à-envoyer au garant pour sa pièce d’identité signée'}
${o.journal === false ? '' : '\n## Journal\n\n**' + (o.resultat ?? '2026-07-12') + ' 20:07**\n\nExecuteur termine.'}
## Résultat

**${o.resultat ?? '2026-07-12'} 20:07**

resume: ${o.resume ?? 'Message WhatsApp court prêt à copier-coller pour demander sa pièce d’identité signée.'}
livrables: 08-auto/drafts/2026-07-12-message-garant-piece-identite.md
`;
}

/** L'etat de livraison tel que P1 l'ecrit : la peremption ne doit pas l'abimer. */
function etatDeDepart(traitees: Record<string, { le: string; voie: string }> = {}): string {
  return JSON.stringify({ version: 1, traitees });
}

function service(
  fichiers: Record<string, string>,
  jour: string,
  opts: { notify?: NotifyPusher | null; token?: string | null; baseUrl?: string } = {},
) {
  const vault = new InMemoryVaultManager({
    [ETAT_LIVRAISON]: etatDeDepart({ '09-taches/_amorce.md': { le: '2026-09-01', voie: 'fermer' } }),
    ...fichiers,
  });
  const notify = opts.notify === undefined ? new NotifierEspion() : opts.notify;
  const svc = new PeremptionService({
    vault,
    notify,
    baseUrl: opts.baseUrl ?? BASE,
    token: opts.token === undefined ? TOKEN : opts.token,
    now: () => new Date(`${jour}T22:20:00Z`),
  });
  return { vault, notify: notify as NotifierEspion | null, svc };
}

const VARIABLES = [
  'LIVRAISON_PEREMPTION_JOURS',
  'LIVRAISON_PEREMPTION_GRACE',
  'LIVRAISON_PEREMPTION_MAX',
  'LIVRAISON_PEREMPTION_SILENCE',
];

afterEach(() => {
  for (const v of VARIABLES) delete process.env[v];
});

// --- helpers purs -----------------------------------------------------------

describe('dateDattente : depuis quand ce livrable attend', () => {
  it('retient l’horodatage du Résultat quand il est PLUS RÉCENT que created', () => {
    // Cas reel du coffre : 2026-07-12-r-sous-tu-as-enfin-tout-envoy-finditnow,
    // created 2026-07-12 et un Resultat du 2026-07-21 (tache relancee).
    const contenu = tache({ created: '2026-07-12', resultat: '2026-07-21' });
    expect(dateDattente(contenu, '09-taches/x.md')).toBe('2026-07-21');
  });

  it('retient created quand l’horodatage du Résultat est plus ancien', () => {
    // Cas reel : trois taches de septembre portent created 2026-09-02 et un
    // Resultat du 2026-09-01 (decalage UTC de l'executeur).
    const contenu = tache({ created: '2026-09-02', resultat: '2026-09-01' });
    expect(dateDattente(contenu, '09-taches/x.md')).toBe('2026-09-02');
  });

  it('retombe sur la date du nom de fichier, puis sur le repli d’état, puis rend null', () => {
    const nu = '---\ntype: tache\nstatut: a-valider\n---\n\n# Sans date\n';
    expect(dateDattente(nu, '09-taches/2026-05-03-un-truc.md')).toBe('2026-05-03');
    expect(dateDattente(nu, '09-taches/truc.md', '2026-04-01')).toBe('2026-04-01');
    // Jamais la date du jour par defaut : une date inventee perime un livrable
    // neuf ou rajeunit un vieux.
    expect(dateDattente(nu, '09-taches/truc.md')).toBeNull();
    expect(dateDattente(nu, '09-taches/truc.md', 'pas-une-date')).toBeNull();
  });
});

describe('les seuils se lisent dans l’environnement, à l’appel', () => {
  it('joursPeremption rend 21 par défaut et honore un entier de 1 à 365', () => {
    expect(joursPeremption()).toBe(21);
    process.env.LIVRAISON_PEREMPTION_JOURS = '30';
    expect(joursPeremption()).toBe(30);
    process.env.LIVRAISON_PEREMPTION_JOURS = '1';
    expect(joursPeremption()).toBe(1);
  });

  it('rejette 0, un négatif, du texte et une valeur hors bornes', () => {
    for (const mauvais of ['0', '-3', 'abc', '99999', '']) {
      process.env.LIVRAISON_PEREMPTION_JOURS = mauvais;
      expect(joursPeremption()).toBe(21);
    }
  });

  it('joursGrace rend 7 par défaut et honore LIVRAISON_PEREMPTION_GRACE', () => {
    expect(joursGrace()).toBe(7);
    process.env.LIVRAISON_PEREMPTION_GRACE = '3';
    expect(joursGrace()).toBe(3);
    process.env.LIVRAISON_PEREMPTION_GRACE = '200';
    expect(joursGrace()).toBe(7);
  });
});

describe('archiver : le statut bascule et le journal le dit, en une seule chaîne', () => {
  it('remplace a-valider par archivee ET insère la ligne sous ## Journal', () => {
    const ligne = ligneJournal('silence', '2026-07-12', '2026-09-28', '2026-09-21');
    const sortie = archiver(tache(), ligne);
    expect(sortie).not.toBeNull();
    expect(sortie).toContain('statut: archivee');
    expect(sortie).not.toContain('statut: a-valider');
    const apresTitre = (sortie as string).split('## Journal')[1];
    expect(apresTitre.startsWith(`\n- ${ligne}`)).toBe(true);
  });

  it('insère en fin de fichier quand le titre ## Journal manque', () => {
    const sortie = archiver(tache({ journal: false }), 'ligne');
    expect(sortie).toContain('statut: archivee');
    expect((sortie as string).trimEnd().endsWith('- ligne')).toBe(true);
  });

  it('rend null quand la fiche n’est plus a-valider : aucun fichier réécrit', () => {
    expect(archiver(tache({ statut: 'validee' }), 'ligne')).toBeNull();
    expect(archiver(tache({ statut: 'archivee' }), 'ligne')).toBeNull();
  });
});

describe('le statut, c’est la PREMIÈRE ligne statut: et rien d’autre', () => {
  // Mesure sur le coffre (2026-09-22) : cinq fiches de juillet portent
  // plusieurs lignes `statut:`. 2026-07-11-donne-suite-a-cet-insight en porte
  // SIX, « validee » en tête et « a-valider » en queue. Un grep sur le fichier
  // en compte 34 en attente ; la file réelle en compte 29.
  const empilee = `---
type: tache
statut: validee
statut: a-controler
statut: proposee
statut: en-cours
statut: a-controler
statut: a-valider
created: 2026-07-11
---

# Donne suite à cet insight du penseur de nuit

## Journal
`;

  it('ne prend pas une fiche validée pour une fiche en attente', () => {
    expect(estAValider(empilee)).toBe(false);
    expect(estAValider(tache())).toBe(true);
  });

  it('n’archive JAMAIS une fiche dont la vraie valeur est validee', async () => {
    expect(archiver(empilee, 'ligne')).toBeNull();
    const { svc, notify, vault } = service({ '09-taches/empilee.md': empilee }, '2026-09-22');
    const r = await svc.run();
    expect(r.examines).toBe(0);
    expect(r.demandee).toBeNull();
    expect((notify as NotifierEspion).pushed).toHaveLength(0);
    expect(await vault.readFile('09-taches/empilee.md')).toBe(empilee);
  });

  it('bascule la PREMIÈRE ligne quand c’est bien elle qui dit a-valider', () => {
    const double = tache().replace('cible: vault', 'cible: vault\nstatut: a-valider');
    const sortie = archiver(double, 'ligne') as string;
    const statuts = sortie.split('\n').filter(l => l.startsWith('statut:'));
    expect(statuts[0]).toBe('statut: archivee');
    expect(statuts[1]).toBe('statut: a-valider');
  });
});

describe('la prose produite', () => {
  it('formate une date en français', () => {
    expect(formaterDate('2026-07-12')).toBe('12 juillet 2026');
    expect(formaterDate('2026-01-01')).toBe('1 janvier 2026');
  });

  it('compte les jours pleins et rend 0 sur une date illisible', () => {
    expect(joursEntre('2026-07-12', '2026-09-21')).toBe(71);
    expect(joursEntre('2026-09-21', '2026-09-21')).toBe(0);
    expect(joursEntre('pas-une-date', '2026-09-21')).toBe(0);
  });

  it('ne contient AUCUN tiret long, ni en journal ni en notification', async () => {
    const { svc, notify } = service({ [GARANT]: tache() }, '2026-09-21');
    await svc.run();
    const prose = [
      ligneJournal('silence', '2026-07-12', '2026-09-28', '2026-09-21'),
      ligneJournal('reponse', '', '2026-09-21'),
      ...(notify as NotifierEspion).pushed.flatMap(n => [n.title, n.message]),
    ].join('\n');
    expect(prose).not.toMatch(TIRETS_LONGS);
  });
});

// --- le service -------------------------------------------------------------

describe('le cas fondateur : la tâche du garant, 71 jours d’attente', () => {
  it('pose EXACTEMENT une question, sur elle, en citant sa date', async () => {
    const { svc, notify } = service({ [GARANT]: tache() }, '2026-09-21');
    const r = await svc.run();

    expect(r.demandee).toBe(GARANT);
    expect(r.archivees).toEqual([]);
    expect(r.dormants).toBe(1);
    const pushed = (notify as NotifierEspion).pushed;
    expect(pushed).toHaveLength(1);
    expect(pushed[0].message).toContain('12 juillet 2026');
    expect(pushed[0].message).toContain('71 jours');
    expect(pushed[0].title).toContain('garant');
  });

  it('porte trois boutons et un click, sans autre paramètre que k et t', async () => {
    const { svc, notify } = service({ [GARANT]: tache() }, '2026-09-21');
    await svc.run();
    const n = (notify as NotifierEspion).pushed[0];
    const t = encodeURIComponent(GARANT);
    expect(n.actions?.map(a => a.url)).toEqual([
      `${BASE}/archive?k=${TOKEN}&t=${t}`,
      `${BASE}/encore?k=${TOKEN}&t=${t}`,
      `${BASE}/revue?k=${TOKEN}`,
    ]);
    expect(n.click).toBe(`${BASE}/note?k=${TOKEN}&t=${t}`);
    // Aucun secret ajoute a une URL : seulement k (le jeton qui circule deja)
    // et t (un chemin de note).
    for (const url of [n.click as string, ...(n.actions ?? []).map(a => a.url)]) {
      const params = [...new URL(url).searchParams.keys()];
      expect(params.every(p => p === 'k' || p === 't')).toBe(true);
    }
  });

  it('normalise un BASE_URL terminé par des barres obliques', async () => {
    const { svc, notify } = service({ [GARANT]: tache() }, '2026-09-21', {
      baseUrl: `${BASE}//`,
    });
    await svc.run();
    expect((notify as NotifierEspion).pushed[0].click).toBe(
      `${BASE}/note?k=${TOKEN}&t=${encodeURIComponent(GARANT)}`,
    );
  });
});

describe('le seuil', () => {
  it('ne dit rien d’un livrable de 5 jours', async () => {
    const { svc, notify, vault } = service(
      { '09-taches/a.md': tache({ created: '2026-09-16', resultat: '2026-09-16' }) },
      '2026-09-21',
    );
    const r = await svc.run();
    expect(r.demandee).toBeNull();
    expect(r.archivees).toEqual([]);
    expect(r.dormants).toBe(0);
    expect((notify as NotifierEspion).pushed).toHaveLength(0);
    // Rien n'a change : l'etat n'est pas reecrit.
    expect(JSON.parse(await vault.readFile(ETAT_LIVRAISON)).peremption).toBeUndefined();
  });

  it('honore LIVRAISON_PEREMPTION_JOURS', async () => {
    process.env.LIVRAISON_PEREMPTION_JOURS = '3';
    const { svc } = service(
      { '09-taches/a.md': tache({ created: '2026-09-16', resultat: '2026-09-16' }) },
      '2026-09-21',
    );
    expect((await svc.run()).demandee).toBe('09-taches/a.md');
  });
});

describe('la question ne se repose jamais deux fois', () => {
  it('deux passages le même jour, puis un troisième trois jours plus tard : UNE question', async () => {
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: etatDeDepart(),
      [GARANT]: tache(),
    });
    const notify = new NotifierEspion();
    const faire = (jour: string) =>
      new PeremptionService({
        vault,
        notify,
        baseUrl: BASE,
        token: TOKEN,
        now: () => new Date(`${jour}T22:20:00Z`),
      }).run();

    expect((await faire('2026-09-21')).demandee).toBe(GARANT);
    expect((await faire('2026-09-21')).demandee).toBeNull();
    expect((await faire('2026-09-24')).demandee).toBeNull();
    expect(notify.pushed).toHaveLength(1);
  });
});

describe('le volume', () => {
  it('avec 10 livrables périmés, UNE notification, sur le plus ancien, qui annonce les 9 autres', async () => {
    const fichiers: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const jour = String(10 + i).padStart(2, '0');
      fichiers[`09-taches/t${i}.md`] = tache({
        created: `2026-06-${jour}`,
        resultat: `2026-06-${jour}`,
        titre: `Tache ${i}`,
      });
    }
    const { svc, notify } = service(fichiers, '2026-09-21');
    const r = await svc.run();
    expect(r.dormants).toBe(10);
    expect(r.demandee).toBe('09-taches/t0.md');
    expect((notify as NotifierEspion).pushed).toHaveLength(1);
    expect((notify as NotifierEspion).pushed[0].message).toContain('9 autre(s)');
  });
});

describe('le silence vaut réponse, après la grâce', () => {
  const avecQuestion = (jourQuestion: string) => ({
    [ETAT_LIVRAISON]: JSON.stringify({
      version: 1,
      traitees: {},
      peremption: { [GARANT]: { demandeeLe: jourQuestion } },
    }),
    [GARANT]: tache(),
  });

  it('archive à J+7 : le statut bascule, le journal cite la date d’attente', async () => {
    const { svc, vault } = service(avecQuestion('2026-09-21'), '2026-09-28');
    const r = await svc.run();
    expect(r.archivees).toEqual([GARANT]);
    const fiche = await vault.readFile(GARANT);
    expect(fiche).toContain('statut: archivee');
    expect(fiche).toMatch(/- \[peremption 2026-09-28\] Archivée/);
    expect(fiche).toContain('12 juillet 2026');
  });

  it('n’archive rien à J+6 : la frontière de la grâce est stricte', async () => {
    const { svc, vault } = service(avecQuestion('2026-09-21'), '2026-09-27');
    expect((await svc.run()).archivees).toEqual([]);
    expect(await vault.readFile(GARANT)).toContain('statut: a-valider');
  });

  it('n’archive jamais avec LIVRAISON_PEREMPTION_SILENCE=off, même à J+30', async () => {
    process.env.LIVRAISON_PEREMPTION_SILENCE = 'off';
    const { svc, vault } = service(avecQuestion('2026-09-21'), '2026-10-21');
    expect((await svc.run()).archivees).toEqual([]);
    expect(await vault.readFile(GARANT)).toContain('statut: a-valider');
  });

  it('plafonne les archivages à LIVRAISON_PEREMPTION_MAX et laisse le reste en file', async () => {
    const fichiers: Record<string, string> = {};
    const marques: Record<string, { demandeeLe: string }> = {};
    for (let i = 0; i < 12; i++) {
      const chemin = `09-taches/t${String(i).padStart(2, '0')}.md`;
      fichiers[chemin] = tache({ titre: `Tache ${i}` });
      marques[chemin] = { demandeeLe: '2026-09-21' };
    }
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: JSON.stringify({ version: 1, traitees: {}, peremption: marques }),
      ...fichiers,
    });
    const r = await new PeremptionService({
      vault,
      notify: null,
      now: () => new Date('2026-09-28T22:20:00Z'),
    }).run();
    expect(r.archivees).toHaveLength(5);
    let restants = 0;
    for (const chemin of Object.keys(fichiers)) {
      if ((await vault.readFile(chemin)).includes('statut: a-valider')) restants++;
    }
    expect(restants).toBe(7);
  });

  it('envoie UN compte rendu de priorité 2 quand il n’y a rien à demander', async () => {
    // Le livrable archive etait le seul perime : plus rien a demander, mais le
    // mandat autonome exige que le cerveau DISE ce qu'il a fait seul.
    const { svc, notify } = service(avecQuestion('2026-09-21'), '2026-09-28');
    await svc.run();
    const pushed = (notify as NotifierEspion).pushed;
    expect(pushed).toHaveLength(1);
    expect(pushed[0].title).toBe('Ménage des livrables');
    expect(pushed[0].priority).toBe(2);
    expect(pushed[0].message).toContain('garant');
  });
});

describe('« encore utile » remet le compteur à zéro', () => {
  it('ne redemande rien à J+1 et redevient candidate seulement à J+21', async () => {
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: etatDeDepart(),
      [GARANT]: tache(),
    });
    await marquerEncoreUtile(vault, GARANT, '2026-09-21');
    const faire = (jour: string) =>
      new PeremptionService({
        vault,
        notify: null,
        now: () => new Date(`${jour}T22:20:00Z`),
      }).run();

    const lendemain = await faire('2026-09-22');
    expect(lendemain.demandee).toBeNull();
    expect(lendemain.archivees).toEqual([]);
    expect((await faire('2026-10-11')).demandee).toBeNull(); // J+20
    expect((await faire('2026-10-12')).demandee).toBe(GARANT); // J+21
  });
});

describe('les courses et le périmètre', () => {
  it('ne réécrit pas une fiche que Darius vient de valider entre la lecture et l’écriture', async () => {
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: JSON.stringify({
        version: 1,
        traitees: {},
        peremption: { [GARANT]: { demandeeLe: '2026-09-21' } },
      }),
      [GARANT]: tache(),
    });
    const vraiRead = vault.readFile.bind(vault);
    let lectures = 0;
    vault.readFile = async (p: string) => {
      const contenu = await vraiRead(p);
      // La relecture juste avant l'ecriture tombe sur un statut deja bascule.
      if (p === GARANT && lectures++ === 0) return contenu;
      return p === GARANT ? contenu.replace('statut: a-valider', 'statut: validee') : contenu;
    };
    const r = await new PeremptionService({
      vault,
      notify: null,
      now: () => new Date('2026-09-28T22:20:00Z'),
    }).run();
    expect(r.archivees).toEqual([]);
  });

  it('ignore echouee, question-posee, proposee, validee, en-cours et les fichiers en _', async () => {
    const { svc, notify } = service(
      {
        '09-taches/a.md': tache({ statut: 'echouee' }),
        '09-taches/b.md': tache({ statut: 'question-posee' }),
        '09-taches/c.md': tache({ statut: 'proposee' }),
        '09-taches/d.md': tache({ statut: 'validee' }),
        '09-taches/e.md': tache({ statut: 'en-cours' }),
        '09-taches/_darius.md': tache(),
      },
      '2026-09-21',
    );
    const r = await svc.run();
    expect(r.examines).toBe(0);
    expect(r.demandee).toBeNull();
    expect(r.archivees).toEqual([]);
    expect((notify as NotifierEspion).pushed).toHaveLength(0);
  });

  it('purge les marques des tâches qui ne sont plus a-valider, sans toucher aux clés traitees', async () => {
    const traitees = { '09-taches/vieille.md': { le: '2026-09-01', voie: 'fermer' } };
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: JSON.stringify({
        version: 1,
        traitees,
        peremption: { '09-taches/partie.md': { demandeeLe: '2026-09-01' } },
      }),
      '09-taches/partie.md': tache({ statut: 'validee' }),
    });
    await new PeremptionService({
      vault,
      notify: null,
      now: () => new Date('2026-09-21T22:20:00Z'),
    }).run();
    const etat = await lireEtat(vault);
    expect(etat.peremption).toBeUndefined();
    expect(etat.traitees['09-taches/vieille.md']).toEqual({ le: '2026-09-01', voie: 'fermer' });
  });

  it('sans notify et sans jeton : rien ne jette, aucune URL, et le silence archive quand même', async () => {
    const vault = new InMemoryVaultManager({
      [ETAT_LIVRAISON]: JSON.stringify({
        version: 1,
        traitees: {},
        peremption: { [GARANT]: { demandeeLe: '2026-09-21' } },
      }),
      [GARANT]: tache(),
      '09-taches/autre.md': tache({ titre: 'Un autre vieux livrable' }),
    });
    const r = await new PeremptionService({
      vault,
      notify: null,
      token: null,
      baseUrl: BASE,
      now: () => new Date('2026-09-28T22:20:00Z'),
    }).run();
    expect(r.archivees).toEqual([GARANT]);
    expect(r.demandee).toBe('09-taches/autre.md');
  });
});
