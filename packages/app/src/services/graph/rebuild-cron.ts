import cron from 'node-cron';
import type { GraphService } from '@/services/graph/graph-service';
import { logger } from '@/utils/logger';
import { pouls } from '@/services/health/pouls';

// 08:30 UTC = 04:30 a Montreal : le coffre est calme, les workers de nuit ont
// fini, et le brief du matin (11:15 UTC) lira un graphe verifie.
const DEFAULT_SCHEDULE = '30 8 * * *';

/**
 * La reconstruction complete NOCTURNE du graphe : le filet de verite du
 * batissage differentiel.
 *
 * Depuis que le webhook applique des deltas (applyChanges), plus rien ne
 * rebalaye l'ensemble du coffre. Or un differentiel derive par construction :
 * une suppression ratee, un webhook perdu, un bug de removeNote, et l'ecart
 * s'accumule sans bruit. Cette passe rejoue le build complet une fois par
 * jour ; avec le cache chaud elle ne rappelle le LLM que pour les notes dont
 * l'empreinte a change, donc son cout marginal est nul. C'est aussi ICI, et
 * seulement ici, que vit la reparation des extractions vides : sur le chemin
 * d'un push, ce budget de 20 retentatives se redepensait 80 a 214 fois par
 * jour sans jamais converger.
 *
 * Le differentiel sert la fraicheur, cette reconstruction sert la verite.
 *
 * Desactivation : GRAPH_REBUILD=off. Horaire : GRAPH_REBUILD_CRON.
 */
export function scheduleGraphRebuild(graph: GraphService): boolean {
  if ((process.env.GRAPH_REBUILD || 'on').toLowerCase() === 'off') {
    logger.info('Nightly graph rebuild disabled (GRAPH_REBUILD=off)');
    return false;
  }

  const schedule = process.env.GRAPH_REBUILD_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid GRAPH_REBUILD_CRON — nightly rebuild not scheduled', { schedule });
    return false;
  }

  cron.schedule(schedule, () => {
    void runRebuild(graph);
  });
  logger.info('Nightly graph rebuild scheduled', { schedule });
  return true;
}

async function runRebuild(graph: GraphService): Promise<void> {
  try {
    logger.info('Nightly graph rebuild starting');
    const r = await graph.build();
    pouls.marque('graph-rebuild', !r.alarm, r.alarm ? 'reextraction massive (cache perdu ?)' : undefined, {
      direct: true,
    });
    logger.info('Nightly graph rebuild complete', { ...r });
  } catch (error) {
    pouls.marque('graph-rebuild', false, String(error), { direct: true });
    logger.error('Nightly graph rebuild failed', { error: String(error) });
  }
}
