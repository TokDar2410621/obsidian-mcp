import cron from 'node-cron';
import type { BattementDeCoeur } from '@/services/health/battement';
import { logger } from '@/utils/logger';

// 12:00 & 23:00 UTC = 08:00 & 19:00 Montréal in summer, 07:00 & 18:00 in
// winter: a priority-5 scream pierces silent mode, so the morning audit must
// NEVER land before 7 am Montréal in any season. Twice a day is a reminder
// while broken, not spam (and the scream itself is throttled in battement.ts).
const DEFAULT_SCHEDULE = '0 12,23 * * *';

/**
 * Schedule the battement de coeur. Disable with `SANTE=off`, retime with
 * `SANTE_CRON`. Also runs once at boot (a component that died while the
 * container was down should be caught immediately, not 12 hours later).
 */
export function scheduleBattement(battement: BattementDeCoeur): boolean {
  if ((process.env.SANTE || 'on').toLowerCase() === 'off') {
    logger.info('Battement de coeur disabled (SANTE=off)');
    return false;
  }
  const schedule = process.env.SANTE_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid SANTE_CRON : battement not scheduled', { schedule });
    return false;
  }
  cron.schedule(schedule, () => {
    battement
      .battre()
      .then(r =>
        logger.info('Battement de coeur (cron) done', {
          problemes: r.problemes.length,
          notifie: r.notifie,
        }),
      )
      .catch(error => logger.error('Battement de coeur (cron) failed', { error: String(error) }));
  });
  logger.info('Battement de coeur scheduled', { schedule });
  return true;
}
