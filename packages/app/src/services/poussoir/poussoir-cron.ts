import cron from 'node-cron';
import type { PoussoirService } from '@/services/poussoir/poussoir';
import { pouls } from '@/services/health/pouls';
import { logger } from '@/utils/logger';

// 13:30 UTC = 09:30 Montréal (été): the gesture lands with the coffee, after
// the brief. 00:30 UTC = 20:30 Montréal: the evening reckoning.
const DEFAULT_MATIN = '30 13 * * *';
const DEFAULT_SOIR = '30 0 * * *';

/**
 * Schedule the poussoir. Disable with `POUSSOIR=off`, retime with
 * `POUSSOIR_MATIN_CRON` / `POUSSOIR_SOIR_CRON`.
 */
export function schedulePoussoir(poussoir: PoussoirService): boolean {
  if ((process.env.POUSSOIR || 'on').toLowerCase() === 'off') {
    logger.info('Poussoir disabled (POUSSOIR=off)');
    return false;
  }
  const matin = process.env.POUSSOIR_MATIN_CRON || DEFAULT_MATIN;
  const soir = process.env.POUSSOIR_SOIR_CRON || DEFAULT_SOIR;
  if (!cron.validate(matin) || !cron.validate(soir)) {
    logger.error('Invalid POUSSOIR_*_CRON : poussoir not scheduled', { matin, soir });
    return false;
  }
  cron.schedule(matin, () => {
    poussoir
      .envoiMatin()
      .then(r => {
        pouls.marque('poussoir', true);
        logger.info('Poussoir matin done', { ...r });
      })
      .catch(error => {
        pouls.marque('poussoir', false, String(error));
        logger.error('Poussoir matin failed', { error: String(error) });
      });
  });
  cron.schedule(soir, () => {
    poussoir
      .relanceSoir()
      .then(r => {
        pouls.marque('poussoir', true);
        logger.info('Poussoir soir done', { ...r });
      })
      .catch(error => {
        pouls.marque('poussoir', false, String(error));
        logger.error('Poussoir soir failed', { error: String(error) });
      });
  });
  logger.info('Poussoir scheduled', { matin, soir });
  return true;
}
