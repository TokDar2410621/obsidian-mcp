import cron from 'node-cron';
import type { CalendarProbeService } from '@/services/sensors/calendar-probe';
import { logger } from '@/utils/logger';
import { pouls } from '@/services/health/pouls';

const DEFAULT_SCHEDULE = '35 */6 * * *'; // every 6 hours at :35 (server/UTC), offset from Stripe

/**
 * Schedule the Google Calendar sensor probe. Dormant without the GOOGLE_OAUTH_*
 * credentials, so scheduling it is harmless before they exist.
 * Disable with `CALENDAR_SENSOR=off`, retime with `CALENDAR_SENSOR_CRON`.
 */
export function scheduleCalendarProbe(probe: CalendarProbeService): boolean {
  if ((process.env.CALENDAR_SENSOR || 'on').toLowerCase() === 'off') {
    logger.info('Calendar probe disabled (CALENDAR_SENSOR=off)');
    return false;
  }

  const schedule = process.env.CALENDAR_SENSOR_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid CALENDAR_SENSOR_CRON — Calendar probe not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    probe
      .runProbe()
      .then(result => {
        // La sonde RESOUT avec { error } quand le fetch echoue (blocage ASN vecu) :
        // une resolution n'est un passage vert que sans erreur.
        pouls.marque('sonde-calendar', !(result as { error?: string })?.error, (result as { error?: string })?.error);
        logger.info('Calendar probe (cron) done', { ...result });
      })
      .catch(error => {
        pouls.marque('sonde-calendar', false, String(error));
        logger.error('Calendar probe (cron) failed', { error: String(error) });
      });
  });
  logger.info('Calendar probe scheduled', { schedule });
  return true;
}
