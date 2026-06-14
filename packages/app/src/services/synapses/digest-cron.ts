import cron from 'node-cron';
import type { VaultManager } from '@/services/vault-manager';
import type { SynapsesService } from '@/services/synapses/synapses-service';
import { logger } from '@/utils/logger';

const DIGEST_FILE = '00-synapses.md';
const DEFAULT_SCHEDULE = '0 8 * * 1'; // Monday 08:00 (server time)

/**
 * Schedule the weekly Synapses digest: run the three analyses and write
 * `00-synapses.md` into the vault (the VaultManager commits + pushes it, which
 * the GitHub webhook then reindexes). Disable with `SYNAPSES_DIGEST=off`,
 * override timing with `SYNAPSES_CRON`. Long-running container only (HTTP mode).
 */
export function scheduleSynapsesDigest(synapses: SynapsesService, vault: VaultManager): boolean {
  if ((process.env.SYNAPSES_DIGEST || 'on').toLowerCase() === 'off') {
    logger.info('Synapses weekly digest disabled (SYNAPSES_DIGEST=off)');
    return false;
  }

  const schedule = process.env.SYNAPSES_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid SYNAPSES_CRON — weekly digest not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    void runDigest(synapses, vault);
  });
  logger.info('Synapses weekly digest scheduled', { schedule, file: DIGEST_FILE });
  return true;
}

async function runDigest(synapses: SynapsesService, vault: VaultManager): Promise<void> {
  try {
    logger.info('Synapses digest starting');
    const markdown = await synapses.digestMarkdown();
    await vault.writeFile(DIGEST_FILE, markdown);
    logger.info('Synapses digest written', { file: DIGEST_FILE });
  } catch (error) {
    logger.error('Synapses digest failed', { error: String(error) });
  }
}
