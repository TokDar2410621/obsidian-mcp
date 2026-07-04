import cron from 'node-cron';
import type { ObjectiveSweepService } from '@/services/objectives/objective-sweep';
import { logger } from '@/utils/logger';

const DEFAULT_SCHEDULE = '30 6 * * *'; // 06:30 server time (UTC), daily — after the reflection

/**
 * Schedule the daily objective sweep. The webhook already sweeps on every vault
 * push; this cron is the deadline heartbeat (échéances fire by calendar, not by
 * note changes) and the catch-up for pushes missed while the container slept.
 * Disable with `OBJECTIVE_SWEEP=off`, retime with `OBJECTIVE_SWEEP_CRON`.
 */
export function scheduleObjectiveSweep(sweep: ObjectiveSweepService): boolean {
  if ((process.env.OBJECTIVE_SWEEP || 'on').toLowerCase() === 'off') {
    logger.info('Objective sweep disabled (OBJECTIVE_SWEEP=off)');
    return false;
  }

  const schedule = process.env.OBJECTIVE_SWEEP_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid OBJECTIVE_SWEEP_CRON — objective sweep not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    sweep
      .runSweep()
      .then(result => logger.info('Objective sweep (cron) done', { ...result }))
      .catch(error => logger.error('Objective sweep (cron) failed', { error: String(error) }));
  });
  logger.info('Objective sweep scheduled', { schedule });
  return true;
}
