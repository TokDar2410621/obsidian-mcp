import cron from 'node-cron';
import type { MorningBriefService } from '@/services/brief/morning-brief';
import { logger } from '@/utils/logger';

const DEFAULT_SCHEDULE = '15 11 * * *'; // 11:15 UTC = 7:15 Montréal (été), après les sweeps du matin

/**
 * Schedule the daily morning brief (one ntfy push with the day's deadline,
 * Darius's #1 priority, and the proposals waiting for him). No boot run: the
 * brief is a daily human message, not a catch-up job, and the service also
 * dedups per-day. Disable with `MORNING_BRIEF=off`, retime with `MORNING_BRIEF_CRON`.
 */
export function scheduleMorningBrief(brief: MorningBriefService): boolean {
  if ((process.env.MORNING_BRIEF || 'on').toLowerCase() === 'off') {
    logger.info('Morning brief disabled (MORNING_BRIEF=off)');
    return false;
  }

  const schedule = process.env.MORNING_BRIEF_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid MORNING_BRIEF_CRON — morning brief not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    brief
      .runBrief()
      .then(result => logger.info('Morning brief (cron) done', { ...result }))
      .catch(error => logger.error('Morning brief (cron) failed', { error: String(error) }));
  });
  logger.info('Morning brief scheduled', { schedule });
  return true;
}
