import cron from 'node-cron';
import type { VaultManager } from '@/services/vault-manager';
import type { LearningService } from '@/services/learning/learning-service';
import { logger } from '@/utils/logger';

const MAINTENANCE_FILE = '00-maintenance.md';
const DEFAULT_SCHEDULE = '0 9 * * 1'; // Monday 09:00 (after the Synapses digest at 08:00)

/**
 * Schedule the weekly maintenance report: consolidation proposals + gaps,
 * written to `00-maintenance.md` (commit+push → reindex). Disable with
 * `MAINTENANCE_ENABLED=off`; override timing with `MAINTENANCE_CRON`.
 */
export function scheduleWeeklyMaintenance(learning: LearningService, vault: VaultManager): boolean {
  if ((process.env.MAINTENANCE_ENABLED || 'on').toLowerCase() === 'off') {
    logger.info('Weekly maintenance disabled (MAINTENANCE_ENABLED=off)');
    return false;
  }
  const schedule = process.env.MAINTENANCE_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid MAINTENANCE_CRON — weekly maintenance not scheduled', { schedule });
    return false;
  }
  cron.schedule(schedule, () => {
    void run(learning, vault);
  });
  logger.info('Weekly maintenance scheduled', { schedule, file: MAINTENANCE_FILE });
  return true;
}

async function run(learning: LearningService, vault: VaultManager): Promise<void> {
  try {
    logger.info('Maintenance report starting');
    const markdown = await learning.maintenanceMarkdown();
    await vault.writeFile(MAINTENANCE_FILE, markdown);
    logger.info('Maintenance report written', { file: MAINTENANCE_FILE });
  } catch (error) {
    logger.error('Maintenance report failed', { error: String(error) });
  }
}
