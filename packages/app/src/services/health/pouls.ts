import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
import { logger } from '@/utils/logger';

/**
 * Pouls: the run-stamp of every SERVER cron. Each cron marks its passage
 * here; the battement-de-coeur audit later reads the marks and screams when
 * a component sleeps. Without this, the server's own crons are unwatched:
 * the ingestion spec sat with `last_run: null` for a MONTH and nobody knew
 * (the exact blindness this whole health layer exists to remove).
 *
 * In-memory map, persisted to 08-auto/_sante-crons.json so a redeploy does
 * not erase history (Railway restarts often; an amnesiac pulse would cry
 * wolf after every deploy). Persistence is lazy and never throws: a broken
 * vault write must not take a cron down with it.
 */

export interface MarqueCron {
  /** ISO datetime of the last completed run. */
  t: string;
  /** Whether that run succeeded. */
  ok: boolean;
  /** Short error note when ok=false. */
  note?: string;
}

const FICHIER = '08-auto/_sante-crons.json';

class Pouls {
  private marques = new Map<string, MarqueCron>();
  private vault: VaultManager | null = null;
  private charge = false;

  /** Bind the vault (call once at boot) and load persisted marks. */
  async lier(vault: VaultManager): Promise<void> {
    this.vault = vault;
    try {
      const raw = JSON.parse(await vault.readFile(FICHIER)) as Record<string, MarqueCron>;
      for (const [nom, m] of Object.entries(raw)) {
        if (!m || typeof m.t !== 'string') continue;
        // A cron may have marked in memory while this load was in flight
        // (boot catch-up sweeps): the fresher mark wins, never the file.
        const enMemoire = this.marques.get(nom);
        if (!enMemoire || Date.parse(m.t) > Date.parse(enMemoire.t)) this.marques.set(nom, m);
      }
    } catch {
      /* first boot: no file yet */
    }
    this.charge = true;
  }

  /** Record that cron `nom` just finished (ok or not). Never throws.
   *  `direct: true` persists with an immediate commit instead of the lazy
   *  channel: a WEEKLY mark lost to a crash inside the 5-minute lazy window
   *  would take a full week to be re-stamped, and buy days of false screams
   *  in between. Dailies self-heal tomorrow; weeklies pay for eagerness. */
  marque(nom: string, ok: boolean, note?: string, opts?: { direct?: boolean }): void {
    this.marques.set(nom, {
      t: new Date().toISOString(),
      ok,
      ...(note ? { note: note.slice(0, 200) } : {}),
    });
    if (!this.vault || !this.charge) return;
    const objet = Object.fromEntries(this.marques);
    const contenu = JSON.stringify(objet, null, 2);
    const ecrire = opts?.direct
      ? this.vault.writeFile(FICHIER, contenu)
      : writeStateFile(this.vault, FICHIER, contenu);
    ecrire.catch(error => logger.warn('pouls: persistence failed', { error: String(error) }));
  }

  /** Snapshot for the audit. */
  instantane(): Record<string, MarqueCron> {
    return Object.fromEntries(this.marques);
  }

  /** Test-only reset. */
  _reset(): void {
    this.marques.clear();
    this.vault = null;
    this.charge = false;
  }
}

/** Process-wide singleton: cron wrappers import it directly, no rewiring. */
export const pouls = new Pouls();
