import cron from 'node-cron';
import type { RelanceSweepService } from '@/services/relance/relance-sweep';
import { logger } from '@/utils/logger';

const DEFAULT_SCHEDULE = '5 22 * * *'; // 22:05 UTC = 18:05 Montréal (été) : fin de journée, l'heure des comptes

/**
 * Schedule the daily relance sweep: anything Darius owes with no progress for
 * a day gets ONE "pourquoi ?" ntfy with one-tap answer buttons. Disable with
 * `RELANCE_SWEEP=off`, retime with `RELANCE_SWEEP_CRON`.
 */
export function scheduleRelanceSweep(sweep: RelanceSweepService): boolean {
  if ((process.env.RELANCE_SWEEP || 'on').toLowerCase() === 'off') {
    logger.info('Relance sweep disabled (RELANCE_SWEEP=off)');
    return false;
  }

  const schedule = process.env.RELANCE_SWEEP_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid RELANCE_SWEEP_CRON — relance sweep not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    sweep
      .runSweep()
      .then(result => logger.info('Relance sweep (cron) done', { ...result }))
      .catch(error => logger.error('Relance sweep (cron) failed', { error: String(error) }));
  });
  logger.info('Relance sweep scheduled', { schedule });
  return true;
}
