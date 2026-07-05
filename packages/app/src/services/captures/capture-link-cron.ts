import cron from 'node-cron';
import type { CaptureLinkSweepService } from '@/services/captures/capture-link-sweep';
import { logger } from '@/utils/logger';

const DEFAULT_SCHEDULE = '45 6 * * *'; // 06:45 server time (UTC), daily, just after the objective sweep

/**
 * Schedule the daily capture link sweep: link fresh inbox captures to the
 * project each could advance, stage proposals under `08-auto/` and push one
 * ntfy. Disable with `CAPTURE_LINK=off`, retime with `CAPTURE_LINK_CRON`.
 */
export function scheduleCaptureLinkSweep(sweep: CaptureLinkSweepService): boolean {
  if ((process.env.CAPTURE_LINK || 'on').toLowerCase() === 'off') {
    logger.info('Capture link sweep disabled (CAPTURE_LINK=off)');
    return false;
  }

  const schedule = process.env.CAPTURE_LINK_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid CAPTURE_LINK_CRON — capture link sweep not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    sweep
      .runSweep()
      .then(result => logger.info('Capture link sweep (cron) done', { ...result }))
      .catch(error => logger.error('Capture link sweep (cron) failed', { error: String(error) }));
  });
  logger.info('Capture link sweep scheduled', { schedule });
  return true;
}
