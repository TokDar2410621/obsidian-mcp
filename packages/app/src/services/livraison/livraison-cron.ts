import cron from 'node-cron';
import type { LivraisonService } from '@/services/livraison/livraison';
import { pouls } from '@/services/health/pouls';
import { logger } from '@/utils/logger';

/**
 * Toutes les 5 minutes : ce qui vient d'etre fini part chez Darius, ou se
 * ferme. Court intervalle assume, parce que la valeur d'une livraison decroit
 * vite : une reponse recue pendant qu'on y pense encore vaut dix fois la meme
 * reponse retrouvee trois jours plus tard dans une file de 81.
 *
 * Un cron plutot qu'un branchement sur le webhook : la chaine du webhook vient
 * d'etre stabilisee (boucle `_echos.md` du 2026-09-21), on ne lui rajoute rien.
 * Le passage lit tout le repertoire des taches en UNE synchronisation.
 */
const DEFAULT_SCHEDULE = '*/5 * * * *';

export function scheduleLivraison(livraison: LivraisonService): boolean {
  if ((process.env.LIVRAISON || 'on').toLowerCase() === 'off') {
    logger.info('Livraison disabled (LIVRAISON=off)');
    return false;
  }
  const schedule = process.env.LIVRAISON_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid LIVRAISON_CRON : livraison not scheduled', { schedule });
    return false;
  }
  cron.schedule(schedule, () => {
    livraison
      .run()
      .then(r => {
        pouls.marque('livraison', true);
        if (r.annoncees + r.fermees > 0) logger.info('Livraison passe', { ...r });
      })
      .catch(error => {
        pouls.marque('livraison', false, String(error));
        logger.error('Livraison failed', { error: String(error) });
      });
  });
  logger.info('Livraison scheduled', { schedule });
  return true;
}
