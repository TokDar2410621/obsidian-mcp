import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import type { MarqueCron } from '@/services/health/pouls';
import { logger } from '@/utils/logger';

/**
 * Battement de coeur: the twice-daily audit that verifies EVERY component of
 * the cerveau actually ran, and SCREAMS (ntfy priority 5) when one sleeps.
 *
 * Why it exists (all lived, all silent):
 *  - the ingestion agent never ran once (`last_run: null`), unnoticed for weeks;
 *  - the night thinker timed out every night while its heartbeat kept saying
 *    `status: ok`, because the failure lives in the FRENCH keys
 *    (`statut: echec`, `erreur: ...`) that the brief's watchdog never read;
 *  - the whole PC2 layer froze 24h on a git conflict.
 *
 * Two sources:
 *  - PC2 workers: their vault beats (08-auto/_veille-workers/*.json) plus the
 *    live HTTP telemetry (their voice when the git clone is frozen).
 *  - Server crons: the pouls marks (each cron stamps its passage).
 *
 * A watchman that cries wolf ends up muted, so false screams are treated as
 * bugs of the same rank as silent failures: per-component cadences match the
 * REAL schedules (the courtier runs weekly, not daily), kill-switched crons
 * are dormant rather than "muet", a stale `ahead` from the vault must persist
 * across two audits before it counts (the beat itself rides the push it
 * measures, so a vault copy showing ahead>0 is structurally out of date),
 * and screams are throttled: a new problem cries immediately, a lasting one
 * cries at most every RECRI_H hours no matter how many times Railway reboots.
 *
 * Blind spot, by construction: a DEAD server audits nothing. The reverse
 * witness is PC2's push-watchdog, which checks the freshness of the pouls
 * file (08-auto/_sante-crons.json) on origin and screams when the whole
 * server goes quiet. The battement does not pretend to watch itself.
 */

interface BattementWorker {
  last?: string;
  ahead?: number;
  status?: string;
  statut?: string; // French twin of status, written by several PC2 workers
  last_error?: string | null;
  erreur?: string | null; // French twin of last_error
  machine?: string;
}

export type Verdict = 'ok' | 'muet' | 'echec' | 'retenu' | 'absent' | 'dormant' | 'inconnu';

export interface LigneSante {
  composant: string;
  genre: 'worker' | 'cron';
  verdict: Verdict;
  detail: string;
}

export interface ResultatAudit {
  lignes: LigneSante[];
  problemes: LigneSante[];
  notifie: boolean;
  retabli: boolean;
}

/** PC2 workers and how long they may stay silent before it is a scream.
 *  Cadences follow the REAL schedules (setup-pc2.ps1): chef/portier/video
 *  cycle continuously, the night thinker is nightly, courtier and dissonance
 *  are WEEKLY (Sunday night): judging a weekly worker daily guarantees ten
 *  false screams a week. The first four are REQUIRED (no beat at all =
 *  alert); the weekly two only alert once they have beaten at least once. */
const WORKERS: Array<{ cle: string; cadenceH: number; requis: boolean }> = [
  { cle: 'chef-de-chantier', cadenceH: 8, requis: true },
  { cle: 'portier', cadenceH: 8, requis: true },
  { cle: 'video', cadenceH: 8, requis: true },
  { cle: 'penseur-de-nuit', cadenceH: 36, requis: true },
  { cle: 'courtier', cadenceH: 9 * 24, requis: false },
  { cle: 'dissonance', cadenceH: 9 * 24, requis: false },
];

/** Server crons: pouls mark name, allowed silence, what makes each one
 *  legitimately dormant. `dormantSans` = required credentials (a probe
 *  without its key must not alert); `dormantSiOff` = the cron's own
 *  kill-switch (X=off is a legitimate config, not an outage: without this,
 *  flipping a switch buys two false screams a day, forever). */
const CRONS: Array<{
  nom: string;
  label: string;
  cadenceH: number;
  dormantSans?: string[];
  dormantSiOff?: string;
}> = [
  { nom: 'reflexion', label: 'Réflexion nocturne', cadenceH: 30, dormantSiOff: 'DAILY_REFLECTION' },
  { nom: 'brief-matin', label: 'Brief du matin', cadenceH: 30, dormantSiOff: 'MORNING_BRIEF' },
  { nom: 'sweep-objectifs', label: 'Sweep objectifs', cadenceH: 30, dormantSiOff: 'OBJECTIVE_SWEEP' },
  { nom: 'sweep-captures', label: 'Sweep captures', cadenceH: 30, dormantSiOff: 'CAPTURE_LINK' },
  { nom: 'relance', label: 'Relance', cadenceH: 30, dormantSiOff: 'RELANCE_SWEEP' },
  {
    nom: 'sonde-stripe',
    label: 'Sonde Stripe',
    cadenceH: 26,
    dormantSans: ['STRIPE_API_KEY'],
    dormantSiOff: 'STRIPE_SENSOR',
  },
  {
    nom: 'sonde-calendar',
    label: 'Sonde Calendar',
    cadenceH: 26,
    dormantSans: ['GOOGLE_OAUTH_REFRESH_TOKEN'],
    dormantSiOff: 'CALENDAR_SENSOR',
  },
  { nom: 'synapses-digest', label: 'Digest synapses', cadenceH: 8 * 24, dormantSiOff: 'SYNAPSES_DIGEST' },
  {
    nom: 'maintenance-hebdo',
    label: 'Maintenance hebdo',
    cadenceH: 9 * 24,
    dormantSiOff: 'MAINTENANCE_ENABLED',
  },
  { nom: 'poussoir', label: 'Poussoir', cadenceH: 30, dormantSiOff: 'POUSSOIR' },
  {
    nom: 'retours',
    label: 'Retours du monde',
    cadenceH: 30,
    dormantSans: ['PUBLIAR_API_KEY'],
    dormantSiOff: 'RETOURS',
  },
];

/** Components that exist but leave no watchable trace yet. Listed in the
 *  bulletin so the gap stays VISIBLE instead of silently uncovered. (The
 *  insight worker is NOT here: it beats under the key penseur-de-nuit.) */
const NON_SURVEILLES = [
  'digest gmail (PC2)',
  'digest whatsapp (PC2)',
  'sonde-produit (PC2)',
  'push-watchdog (PC2, le témoin inverse)',
  'boucle-adaptative (PC2, hebdo)',
];

const HEARTBEAT_DIR = '08-auto/_veille-workers';
const BULLETIN = '08-auto/_sante.md';
const ETAT = '08-auto/_sante-state.json';
const ECHECS = new Set(['error', 'echec', 'sortie non conforme']);
/** A lasting problem re-cries at most every RECRI_H hours: the 2-a-day cron
 *  keeps the reminder alive, and N Railway redeploys a day add ZERO cries. */
const RECRI_H = 11;
/** An `ahead` anomaly must persist at least this long before it screams: the
 *  vault beat computes ahead BEFORE riding the very push it measures, so a
 *  single observation is structurally stale. */
const AHEAD_CONFIRME_H = 6;

interface EtatSante {
  version: 1;
  /** First time the audit ever ran: bootstrap grace for cron marks. */
  premierEveil: string;
  /** Problem keys currently active (key -> ISO of first sighting). */
  actifs: Record<string, string>;
  /** Last time a scream was pushed (throttle anchor). */
  dernierCri: string | null;
  /** ahead anomalies under observation (worker -> ISO of first sighting). */
  aheadVus: Record<string, string>;
}

export interface BattementDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  /** Live worker telemetry (wins over the vault beat when fresher). */
  telemetry?: (() => Record<string, BattementWorker>) | null;
  /** Pouls snapshot of the server crons. */
  poulsSnapshot: () => Record<string, MarqueCron>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

function ageH(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const h = (now.getTime() - t) / 3_600_000;
  return h < 0 ? 0 : h; // future clock: treat as fresh, never as proof of life for days
}

function heures(h: number): string {
  return h >= 48 ? `${Math.round(h / 24)} j` : `${Math.round(h)} h`;
}

export class BattementDeCoeur {
  constructor(private readonly deps: BattementDeps) {}

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  private async lireEtat(now: Date): Promise<EtatSante> {
    const neuf = (premierEveil: string): EtatSante => ({
      version: 1,
      premierEveil,
      actifs: {},
      dernierCri: null,
      aheadVus: {},
    });
    let brut: string;
    try {
      brut = await this.deps.vault.readFile(ETAT);
    } catch {
      // Genuinely first run: the bootstrap grace starts now.
      return neuf(now.toISOString());
    }
    try {
      const p = JSON.parse(brut) as Partial<EtatSante>;
      return {
        version: 1,
        premierEveil: typeof p.premierEveil === 'string' ? p.premierEveil : now.toISOString(),
        actifs: p.actifs && typeof p.actifs === 'object' ? p.actifs : {},
        dernierCri: typeof p.dernierCri === 'string' ? p.dernierCri : null,
        aheadVus: p.aheadVus && typeof p.aheadVus === 'object' ? p.aheadVus : {},
      };
    } catch {
      // CORRUPT file (it exists but does not parse): do NOT re-arm the grace,
      // that would buy 30h of blindness. Assume the pulse is old.
      return neuf(new Date(0).toISOString());
    }
  }

  private async battementWorker(cle: string): Promise<BattementWorker | null> {
    // Freshest of live telemetry vs vault beat: telemetry survives a frozen
    // clone, the vault beat survives a server restart. Never trust only one.
    let duVault: BattementWorker | null = null;
    try {
      duVault = JSON.parse(
        await this.deps.vault.readFile(`${HEARTBEAT_DIR}/${cle}.json`),
      ) as BattementWorker;
    } catch {
      /* beat file absent */
    }
    const duLive = this.deps.telemetry?.()?.[cle] ?? null;
    if (!duLive) return duVault;
    if (!duVault) return duLive;
    return Date.parse(duLive.last ?? '') >= Date.parse(duVault.last ?? '') ? duLive : duVault;
  }

  private jugeWorker(
    w: { cle: string; cadenceH: number; requis: boolean },
    beat: BattementWorker | null,
    etat: EtatSante,
    now: Date,
  ): LigneSante {
    const base = { composant: w.cle, genre: 'worker' as const };
    if (!beat) {
      return w.requis
        ? { ...base, verdict: 'absent', detail: 'aucun battement, jamais vu' }
        : { ...base, verdict: 'inconnu', detail: 'jamais vu (non requis)' };
    }
    const age = ageH(beat.last, now);
    if (age === null || age > w.cadenceH) {
      return {
        ...base,
        verdict: 'muet',
        detail: `dernier battement il y a ${age === null ? '?' : heures(age)} (toléré : ${heures(w.cadenceH)})`,
      };
    }
    // A worker can beat "ok" while its actual WORK fails: several PC2 workers
    // report the failure in FRENCH keys (statut/erreur). Read both alphabets.
    const statut = String(beat.statut ?? beat.status ?? '').toLowerCase();
    const erreur = beat.erreur ?? beat.last_error ?? null;
    if (ECHECS.has(statut) || erreur) {
      return {
        ...base,
        verdict: 'echec',
        detail: `tourne mais échoue : ${String(erreur ?? statut).slice(0, 120)}`,
      };
    }
    // `ahead` anomalies (unpushed commits, or -1 = git cannot even answer)
    // only count once CONFIRMED by persistence: the vault beat computes ahead
    // BEFORE riding the push that carries it, so one sighting proves nothing.
    const anomalie = beat.ahead === -1 || (beat.ahead ?? 0) > 0;
    if (anomalie) {
      const depuis = etat.aheadVus[w.cle];
      const persisteH = ageH(depuis, now);
      if (depuis && persisteH !== null && persisteH >= AHEAD_CONFIRME_H) {
        return beat.ahead === -1
          ? {
              ...base,
              verdict: 'retenu',
              detail: `ahead indéterminable depuis ${heures(persisteH)} (git cassé côté worker ?)`,
            }
          : {
              ...base,
              verdict: 'retenu',
              detail: `vivant mais ${beat.ahead} commit(s) non poussé(s) depuis ${heures(persisteH)}`,
            };
      }
      return { ...base, verdict: 'ok', detail: `battement il y a ${heures(age)} (ahead sous observation)` };
    }
    return { ...base, verdict: 'ok', detail: `battement il y a ${heures(age)}` };
  }

  private jugeCron(
    c: { nom: string; label: string; cadenceH: number; dormantSans?: string[]; dormantSiOff?: string },
    marque: MarqueCron | undefined,
    premierEveil: string,
    now: Date,
  ): LigneSante {
    const base = { composant: c.label, genre: 'cron' as const };
    if (c.dormantSiOff && (this.env[c.dormantSiOff] ?? 'on').toLowerCase() === 'off') {
      return { ...base, verdict: 'dormant', detail: `coupé volontairement (${c.dormantSiOff}=off)` };
    }
    if (c.dormantSans && c.dormantSans.some(v => !(this.env[v] ?? '').trim())) {
      return { ...base, verdict: 'dormant', detail: `dormant (${c.dormantSans.join(', ')} absent)` };
    }
    if (!marque) {
      // Bootstrap grace: right after the FIRST deploy of the pulse, no cron
      // has marked yet. Only alert once the pulse has been alive longer than
      // the cron's own cadence: past that, "no mark" means "never ran".
      const eveil = ageH(premierEveil, now) ?? 0;
      return eveil < c.cadenceH
        ? { ...base, verdict: 'inconnu', detail: 'aucune marque encore (démarrage récent)' }
        : { ...base, verdict: 'muet', detail: `aucune marque depuis le premier éveil (${heures(eveil)})` };
    }
    const age = ageH(marque.t, now);
    if (age === null || age > c.cadenceH) {
      return {
        ...base,
        verdict: 'muet',
        detail: `dernier passage il y a ${age === null ? '?' : heures(age)} (toléré : ${heures(c.cadenceH)})`,
      };
    }
    if (!marque.ok) {
      return {
        ...base,
        verdict: 'echec',
        detail: `dernier passage en échec : ${(marque.note ?? 'sans détail').slice(0, 120)}`,
      };
    }
    return { ...base, verdict: 'ok', detail: `passage il y a ${heures(age)}` };
  }

  private bulletin(lignes: LigneSante[], now: Date): string {
    const icone: Record<Verdict, string> = {
      ok: '✅',
      muet: '🔇',
      echec: '💥',
      retenu: '⏸️',
      absent: '❓',
      dormant: '😴',
      inconnu: '➖',
    };
    const rang = (l: LigneSante) =>
      l.verdict === 'ok' || l.verdict === 'dormant' || l.verdict === 'inconnu' ? 1 : 0;
    const tri = [...lignes].sort((a, b) => rang(a) - rang(b));
    const table = tri
      .map(l => `| ${icone[l.verdict]} ${l.composant} | ${l.verdict} | ${l.detail} |`)
      .join('\n');
    return [
      '---',
      'type: systeme',
      'tags: [sante, battement]',
      `updated: ${now.toISOString().slice(0, 10)}`,
      '---',
      '',
      '# Battement de coeur',
      '',
      `Dernier audit : ${now.toISOString()}. Écrit par le serveur ; ne pas éditer.`,
      '',
      '| Composant | Verdict | Détail |',
      '|---|---|---|',
      table,
      '',
      '## Non surveillés (angles morts assumés)',
      '',
      ...NON_SURVEILLES.map(n => `- ${n}`),
      '',
    ].join('\n');
  }

  /** One audit pass: judge everything, write the bulletin, scream if needed. */
  async battre(): Promise<ResultatAudit> {
    const now = this.deps.now?.() ?? new Date();
    const etat = await this.lireEtat(now);
    const marques = this.deps.poulsSnapshot();

    const lignes: LigneSante[] = [];
    const aheadVus: Record<string, string> = {};
    for (const w of WORKERS) {
      try {
        const beat = await this.battementWorker(w.cle);
        const anomalie = beat != null && (beat.ahead === -1 || (beat.ahead ?? 0) > 0);
        if (anomalie) aheadVus[w.cle] = etat.aheadVus[w.cle] ?? now.toISOString();
        lignes.push(this.jugeWorker(w, beat, etat, now));
      } catch (error) {
        lignes.push({
          composant: w.cle,
          genre: 'worker',
          verdict: 'inconnu',
          detail: `juge en erreur : ${String(error).slice(0, 80)}`,
        });
      }
    }
    for (const c of CRONS) {
      lignes.push(this.jugeCron(c, marques[c.nom], etat.premierEveil, now));
    }

    const problemes = lignes.filter(
      l =>
        l.verdict === 'muet' ||
        l.verdict === 'echec' ||
        l.verdict === 'absent' ||
        l.verdict === 'retenu',
    );

    try {
      await writeStateFile(this.deps.vault, BULLETIN, this.bulletin(lignes, now));
    } catch (error) {
      logger.warn('battement: bulletin write failed', { error: String(error) });
    }

    // Scream policy: a NEW problem cries immediately; a lasting one re-cries
    // at most every RECRI_H hours (so redeploys add nothing); full recovery
    // says "retabli" exactly once.
    const avaitActifs = Object.keys(etat.actifs).length > 0;
    let notifie = false;
    let retabli = false;
    let dernierCri = etat.dernierCri;
    const actifs: Record<string, string> = {};
    if (problemes.length > 0) {
      let nouveau = false;
      for (const p of problemes) {
        const deja = etat.actifs[p.composant];
        if (!deja) nouveau = true;
        actifs[p.composant] = deja ?? now.toISOString();
      }
      const criAgeH = ageH(etat.dernierCri ?? undefined, now);
      const du = nouveau || criAgeH === null || criAgeH >= RECRI_H;
      if (du) {
        const corps = problemes
          .slice(0, 8)
          .map(p => `${p.composant} : ${p.detail}`)
          .join('\n');
        const reste =
          problemes.length > 8 ? `\n… et ${problemes.length - 8} de plus (voir _sante.md)` : '';
        try {
          await this.deps.notify?.push({
            title: `🫀 ${problemes.length} composant(s) du cerveau en panne`,
            message: corps + reste,
            priority: 5,
            tags: ['rotating_light'],
          });
          notifie = true;
          dernierCri = now.toISOString();
        } catch {
          /* notifier never throws, belt and braces */
        }
      }
    } else if (avaitActifs) {
      retabli = true;
      dernierCri = null;
      try {
        await this.deps.notify?.push({
          title: '🫀 Battement de coeur : tout est reparti',
          message: 'Tous les composants surveillés battent à nouveau.',
          priority: 3,
          tags: ['white_check_mark'],
        });
      } catch {
        /* idem */
      }
    }

    try {
      await writeStateFile(
        this.deps.vault,
        ETAT,
        JSON.stringify(
          { version: 1, premierEveil: etat.premierEveil, actifs, dernierCri, aheadVus },
          null,
          2,
        ),
      );
    } catch (error) {
      logger.warn('battement: state write failed', { error: String(error) });
    }

    return { lignes, problemes, notifie, retabli };
  }
}
