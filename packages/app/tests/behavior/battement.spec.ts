import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { BattementDeCoeur } from '@/services/health/battement';
import type { Notification, NotifyPusher } from '@/services/notify/notifier';

/**
 * Battement de coeur: silence must be indistinguishable from failure NO MORE.
 * Every case here is a lived incident: the night thinker timing out behind an
 * "ok" status (French keys), the ingestion agent that never ran once, the
 * probe sleeping legitimately without its credential.
 */

const NOW = new Date('2026-08-04T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

class NotifierEspion implements NotifyPusher {
  pushed: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushed.push(n);
  }
}

/** All six watched workers beating fresh and clean. */
function battementsSains(): Record<string, string> {
  const sain = (cle: string) =>
    JSON.stringify({ worker: cle, last: iso(1), status: 'ok', ahead: 0 });
  return Object.fromEntries(
    ['chef-de-chantier', 'portier', 'video', 'penseur-de-nuit', 'courtier', 'dissonance'].map(
      cle => [`08-auto/_veille-workers/${cle}.json`, sain(cle)],
    ),
  );
}

/** Every server cron marked fresh in the pouls. */
function poulsSain(): Record<string, { t: string; ok: boolean; note?: string }> {
  const noms = [
    'reflexion',
    'brief-matin',
    'sweep-objectifs',
    'sweep-captures',
    'relance',
    'sonde-stripe',
    'sonde-calendar',
    'synapses-digest',
    'maintenance-hebdo',
    'poussoir',
  ];
  return Object.fromEntries(noms.map(n => [n, { t: iso(2), ok: true }]));
}

const ENV_COMPLET = { STRIPE_API_KEY: 'sk_x', GOOGLE_OAUTH_REFRESH_TOKEN: 'rt' };

function fabrique(opts: {
  fichiers?: Record<string, string>;
  pouls?: Record<string, { t: string; ok: boolean; note?: string }>;
  env?: Record<string, string | undefined>;
  telemetry?: Record<string, { last?: string; status?: string }>;
  notify?: NotifierEspion;
}) {
  const vault = new InMemoryVaultManager(opts.fichiers ?? battementsSains());
  const notify = opts.notify ?? new NotifierEspion();
  const battement = new BattementDeCoeur({
    vault,
    notify,
    telemetry: opts.telemetry ? () => opts.telemetry! : null,
    poulsSnapshot: () => opts.pouls ?? poulsSain(),
    env: opts.env ?? ENV_COMPLET,
    now: () => NOW,
  });
  return { vault, notify, battement };
}

describe('Battement de coeur : workers PC2', () => {
  it('tout est sain : aucun cri, un bulletin écrit', async () => {
    const { vault, notify, battement } = fabrique({});
    const r = await battement.battre();
    expect(r.problemes).toEqual([]);
    expect(notify.pushed).toEqual([]);
    const bulletin = await vault.readFile('08-auto/_sante.md');
    expect(bulletin).toContain('chef-de-chantier');
    expect(bulletin).toContain('Réflexion nocturne');
  });

  it('lit les clés FRANÇAISES statut/erreur : le bug qui a caché le penseur en échec', async () => {
    // Lived 2026-08-03: penseur beats `status: ok` BUT `statut: echec` +
    // `erreur: claude -p timed out`. The brief read only the English keys and
    // said nothing for days.
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/penseur-de-nuit.json'] = JSON.stringify({
      worker: 'penseur-de-nuit',
      last: iso(2),
      status: 'ok',
      statut: 'echec',
      erreur: "Command '['claude', '-p']' timed out after 1500 seconds",
    });
    const { battement, notify } = fabrique({ fichiers });
    const r = await battement.battre();
    const echec = r.problemes.find(p => p.composant === 'penseur-de-nuit');
    expect(echec?.verdict).toBe('echec');
    expect(echec?.detail).toContain('timed out');
    expect(notify.pushed).toHaveLength(1);
    expect(notify.pushed[0].priority).toBe(5);
  });

  it('un battement trop vieux crie muet', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/video.json'] = JSON.stringify({
      worker: 'video',
      last: iso(30),
      status: 'ok',
    });
    const { battement } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'video')?.verdict).toBe('muet');
  });

  it('un worker requis jamais vu = absent ; un optionnel jamais vu reste silencieux', async () => {
    const fichiers = battementsSains();
    delete fichiers['08-auto/_veille-workers/portier.json']; // requis
    delete fichiers['08-auto/_veille-workers/courtier.json']; // optionnel
    const { battement } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'portier')?.verdict).toBe('absent');
    expect(r.problemes.find(p => p.composant === 'courtier')).toBeUndefined();
  });

  it('ahead > 0 vu une seule fois ne crie PAS : le battement voyage sur le push quil mesure', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/chef-de-chantier.json'] = JSON.stringify({
      worker: 'chef-de-chantier',
      last: iso(1),
      status: 'ok',
      ahead: 3,
    });
    const { battement } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'chef-de-chantier')).toBeUndefined();
    // mais l'anomalie est mise sous observation pour la passe suivante
    const ligne = r.lignes.find(l => l.composant === 'chef-de-chantier');
    expect(ligne?.detail).toContain('observation');
  });

  it('ahead > 0 qui PERSISTE dun audit a lautre crie retenu', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/chef-de-chantier.json'] = JSON.stringify({
      worker: 'chef-de-chantier',
      last: iso(1),
      status: 'ok',
      ahead: 3,
    });
    fichiers['08-auto/_sante-state.json'] = JSON.stringify({
      version: 1,
      premierEveil: iso(72),
      actifs: {},
      dernierCri: null,
      aheadVus: { 'chef-de-chantier': iso(12) },
    });
    const { battement } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'chef-de-chantier')?.verdict).toBe('retenu');
  });

  it('ahead = -1 (git indeterminable) qui persiste crie aussi : le gel de clone vecu', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/video.json'] = JSON.stringify({
      worker: 'video',
      last: iso(1),
      status: 'ok',
      ahead: -1,
    });
    fichiers['08-auto/_sante-state.json'] = JSON.stringify({
      version: 1,
      premierEveil: iso(72),
      actifs: {},
      dernierCri: null,
      aheadVus: { video: iso(12) },
    });
    const { battement } = fabrique({ fichiers });
    const r = await battement.battre();
    const ligne = r.problemes.find(p => p.composant === 'video');
    expect(ligne?.verdict).toBe('retenu');
    expect(ligne?.detail).toContain('git');
  });

  it('le courtier est hebdomadaire : 4 jours de silence ne crient pas', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/courtier.json'] = JSON.stringify({
      worker: 'courtier',
      last: iso(4 * 24),
      status: 'fini',
    });
    const { battement } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'courtier')).toBeUndefined();
  });

  it('la télémétrie live la plus fraîche gagne sur un fichier vault gelé', async () => {
    // The exact failure the vault channel cannot report: clone frozen, beat
    // file stale, but the worker still speaks over HTTP.
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/video.json'] = JSON.stringify({
      worker: 'video',
      last: iso(30),
      status: 'ok',
    });
    const { battement } = fabrique({
      fichiers,
      telemetry: { video: { last: iso(1), status: 'ok' } },
    });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'video')).toBeUndefined();
  });
});

describe('Battement de coeur : crons serveur', () => {
  it('un cron sans marque après son délai de grâce crie muet', async () => {
    const pouls = poulsSain();
    delete pouls['reflexion'];
    const fichiers = {
      ...battementsSains(),
      // premier éveil il y a 3 jours : la grâce de démarrage est finie
      '08-auto/_sante-state.json': JSON.stringify({
        version: 1,
        premierEveil: iso(72),
        actifs: {},
      }),
    };
    const { battement } = fabrique({ fichiers, pouls });
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'Réflexion nocturne')?.verdict).toBe('muet');
  });

  it('juste après le premier déploiement, pas de fausse alerte (grâce de démarrage)', async () => {
    const pouls = poulsSain();
    delete pouls['reflexion'];
    const { battement } = fabrique({ pouls }); // aucun état : premier éveil = maintenant
    const r = await battement.battre();
    expect(r.problemes.find(p => p.composant === 'Réflexion nocturne')).toBeUndefined();
  });

  it('un cron coupe volontairement (X=off) est dormant, jamais muet', async () => {
    const pouls = poulsSain();
    delete pouls['brief-matin'];
    const fichiers = {
      ...battementsSains(),
      '08-auto/_sante-state.json': JSON.stringify({
        version: 1,
        premierEveil: iso(72),
        actifs: {},
        dernierCri: null,
        aheadVus: {},
      }),
    };
    const { battement } = fabrique({
      fichiers,
      pouls,
      env: { ...ENV_COMPLET, MORNING_BRIEF: 'off' },
    });
    const r = await battement.battre();
    const brief = r.lignes.find(l => l.composant === 'Brief du matin');
    expect(brief?.verdict).toBe('dormant');
    expect(r.problemes.find(p => p.composant === 'Brief du matin')).toBeUndefined();
  });

  it('un etat CORROMPU ne rearme pas la grace de demarrage', async () => {
    const pouls = poulsSain();
    delete pouls['reflexion'];
    const fichiers = {
      ...battementsSains(),
      '08-auto/_sante-state.json': 'pas du json {{{',
    };
    const { battement } = fabrique({ fichiers, pouls });
    const r = await battement.battre();
    // fichier present mais illisible : on suppose le pouls VIEUX, donc on crie
    expect(r.problemes.find(p => p.composant === 'Réflexion nocturne')?.verdict).toBe('muet');
  });

  it('une sonde sans sa clé est dormante, jamais en panne', async () => {
    const pouls = poulsSain();
    delete pouls['sonde-stripe'];
    const fichiers = {
      ...battementsSains(),
      '08-auto/_sante-state.json': JSON.stringify({
        version: 1,
        premierEveil: iso(72),
        actifs: {},
      }),
    };
    const { battement } = fabrique({
      fichiers,
      pouls,
      env: { GOOGLE_OAUTH_REFRESH_TOKEN: 'rt' }, // pas de STRIPE_API_KEY
    });
    const r = await battement.battre();
    const stripe = r.lignes.find(l => l.composant === 'Sonde Stripe');
    expect(stripe?.verdict).toBe('dormant');
    expect(r.problemes.find(p => p.composant === 'Sonde Stripe')).toBeUndefined();
  });

  it('une marque en échec crie avec la note', async () => {
    const pouls = poulsSain();
    pouls['relance'] = { t: iso(1), ok: false, note: 'boom réseau' };
    const { battement, notify } = fabrique({ pouls });
    const r = await battement.battre();
    const relance = r.problemes.find(p => p.composant === 'Relance');
    expect(relance?.verdict).toBe('echec');
    expect(relance?.detail).toContain('boom réseau');
    expect(notify.pushed[0].message).toContain('Relance');
  });
});

describe('Battement de coeur : alertes et rétablissement', () => {
  it('un probleme DURABLE ne re-crie pas avant 11 h : les redeploys najoutent rien', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/video.json'] = JSON.stringify({
      worker: 'video',
      last: iso(30),
      status: 'ok',
    });
    fichiers['08-auto/_sante-state.json'] = JSON.stringify({
      version: 1,
      premierEveil: iso(72),
      actifs: { video: iso(13) },
      dernierCri: iso(2), // on a crie il y a 2 h
      aheadVus: {},
    });
    const { battement, notify } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes).toHaveLength(1);
    expect(notify.pushed).toEqual([]); // pas de nouveau cri : deja crie il y a 2 h
  });

  it('un probleme NOUVEAU crie immediatement meme si on vient de crier', async () => {
    const fichiers = battementsSains();
    fichiers['08-auto/_veille-workers/video.json'] = JSON.stringify({
      worker: 'video',
      last: iso(30),
      status: 'ok',
    });
    fichiers['08-auto/_sante-state.json'] = JSON.stringify({
      version: 1,
      premierEveil: iso(72),
      actifs: {}, // video n'etait PAS connu
      dernierCri: iso(1),
      aheadVus: {},
    });
    const { battement, notify } = fabrique({ fichiers });
    await battement.battre();
    expect(notify.pushed).toHaveLength(1);
  });

  it('dit « tout est reparti » exactement quand des actifs retombent à zéro', async () => {
    const fichiers = {
      ...battementsSains(),
      '08-auto/_sante-state.json': JSON.stringify({
        version: 1,
        premierEveil: iso(72),
        actifs: { video: iso(12) },
      }),
    };
    const { battement, notify } = fabrique({ fichiers });
    const r = await battement.battre();
    expect(r.problemes).toEqual([]);
    expect(r.retabli).toBe(true);
    expect(notify.pushed).toHaveLength(1);
    expect(notify.pushed[0].title).toContain('reparti');
    // et l'état est purgé : le prochain passage sain reste silencieux
    const etat = JSON.parse(await fichiers2(battement)) as { actifs: Record<string, string> };
    expect(Object.keys(etat.actifs)).toEqual([]);

    async function fichiers2(_b: unknown): Promise<string> {
      const vault = (battement as unknown as { deps: { vault: InMemoryVaultManager } }).deps.vault;
      return vault.readFile('08-auto/_sante-state.json');
    }
  });

  it('le bulletin liste les angles morts assumés', async () => {
    const { vault, battement } = fabrique({});
    await battement.battre();
    const bulletin = await vault.readFile('08-auto/_sante.md');
    expect(bulletin).toContain('Non surveillés');
    expect(bulletin).toContain('digest gmail');
    expect(bulletin).toContain('push-watchdog');
    // l'insight worker N'EST PAS un angle mort : il bat sous penseur-de-nuit
    expect(bulletin).not.toContain('insight-worker');
  });

  it('plus de 8 problèmes : le cri tronque et renvoie vers le bulletin', async () => {
    const { battement, notify } = fabrique({ fichiers: {}, pouls: {}, env: {} });
    // aucun battement worker, aucune marque, pas de clés : beaucoup de manquants
    const fichiers = {
      '08-auto/_sante-state.json': JSON.stringify({
        version: 1,
        premierEveil: iso(30 * 24),
        actifs: {},
      }),
    };
    const { battement: b2, notify: n2 } = fabrique({ fichiers, pouls: {}, env: {} });
    void battement;
    void notify;
    const r = await b2.battre();
    expect(r.problemes.length).toBeGreaterThan(8);
    expect(n2.pushed[0].message).toContain('de plus');
  });
});
