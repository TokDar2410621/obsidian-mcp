import cron from 'node-cron';
import type { StripeProbeService } from '@/services/sensors/stripe-probe';
import { logger } from '@/utils/logger';

const DEFAULT_SCHEDULE = '15 */6 * * *'; // every 6 hours at :15 (server/UTC)

/**
 * Schedule the Stripe sensor probe. Money is worth a few checks a day, not a
 * webhook the cerveau would have to expose. The probe is dormant without
 * STRIPE_API_KEY, so scheduling it is harmless before the key exists.
 * Disable with `STRIPE_SENSOR=off`, retime with `STRIPE_SENSOR_CRON`.
 */
export function scheduleStripeProbe(probe: StripeProbeService): boolean {
  if ((process.env.STRIPE_SENSOR || 'on').toLowerCase() === 'off') {
    logger.info('Stripe probe disabled (STRIPE_SENSOR=off)');
    return false;
  }

  const schedule = process.env.STRIPE_SENSOR_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid STRIPE_SENSOR_CRON — Stripe probe not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    probe
      .runProbe()
      .then(result => logger.info('Stripe probe (cron) done', { ...result }))
      .catch(error => logger.error('Stripe probe (cron) failed', { error: String(error) }));
  });
  logger.info('Stripe probe scheduled', { schedule });
  return true;
}
