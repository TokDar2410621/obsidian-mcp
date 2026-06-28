import cron from 'node-cron';
import type { ReflectionService } from '@/services/reflection/reflection-service';
import { logger } from '@/utils/logger';

const DEFAULT_SCHEDULE = '0 6 * * *'; // 06:00 server time (UTC), daily

/**
 * Schedule the autonomous daily reflection cycle. Propose-only: the loop writes
 * only under `08-auto/` (the VaultManager commits + pushes, the webhook then
 * reindexes). Disable with `DAILY_REFLECTION=off`, retime with `REFLECTION_CRON`,
 * bound depth with `REFLECTION_MAX_ITEMS`. Long-running container only (HTTP mode).
 */
export function scheduleDailyReflection(reflection: ReflectionService): boolean {
  if ((process.env.DAILY_REFLECTION || 'on').toLowerCase() === 'off') {
    logger.info('Daily reflection disabled (DAILY_REFLECTION=off)');
    return false;
  }

  const schedule = process.env.REFLECTION_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid REFLECTION_CRON — daily reflection not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    void runReflection(reflection);
  });
  logger.info('Daily reflection scheduled', { schedule });
  return true;
}

async function runReflection(reflection: ReflectionService): Promise<void> {
  try {
    logger.info('Daily reflection starting');
    const result = await reflection.runCycle();
    logger.info('Daily reflection done', { date: result.date, processed: result.processed });
  } catch (error) {
    logger.error('Daily reflection failed', { error: String(error) });
  }
}
