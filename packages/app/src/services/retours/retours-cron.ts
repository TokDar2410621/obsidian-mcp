import cron from 'node-cron';
import type { RetoursService } from '@/services/retours/retours';
import { pouls } from '@/services/health/pouls';
import { logger } from '@/utils/logger';

// 11:00 UTC = 07:00 Montréal (été) : AVANT le brief de 11:15 UTC, pour que le
// brief puisse citer des retours frais du matin même.
const DEFAULT_SCHEDULE = '0 11 * * *';

/**
 * Schedule the daily world-feedback pass. Disable with `RETOURS=off`, retime
 * with `RETOURS_CRON`. Long-running container only (HTTP mode).
 */
export function scheduleRetours(retours: RetoursService): boolean {
  if ((process.env.RETOURS || 'on').toLowerCase() === 'off') {
    logger.info('Retours disabled (RETOURS=off)');
    return false;
  }
  const schedule = process.env.RETOURS_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid RETOURS_CRON : retours not scheduled', { schedule });
    return false;
  }
  cron.schedule(schedule, () => {
    retours
      .passe()
      .then(r => {
        pouls.marque('retours', r.ok, r.raison);
        logger.info('Retours pass done', { ...r });
      })
      .catch(error => {
        pouls.marque('retours', false, String(error));
        logger.error('Retours pass failed', { error: String(error) });
      });
  });
  logger.info('Retours scheduled', { schedule });
  return true;
}
