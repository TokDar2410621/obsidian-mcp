import cron from 'node-cron';
import type { PeremptionService } from '@/services/livraison/peremption';
import { pouls } from '@/services/health/pouls';
import { logger } from '@/utils/logger';

/**
 * Une fois par soir : un livrable qui dort depuis trop longtemps recoit UNE
 * question, et le silence finit par l'archiver.
 *
 * 22:20 UTC, soit quinze minutes apres la relance de 22:05. Les deux ecrivent
 * dans la meme boite (l'etat de livraison, la file de notifications) et le
 * decalage suffit pour qu'elles ne se marchent pas dessus. Pas de rattrapage au
 * demarrage : un redeploiement Railway ne doit pas reposer la question du soir.
 *
 * Les variables de ce perimetre, documentees ICI parce que c'est la convention
 * reelle du depot (relance-cron.ts:9-12, livraison-cron.ts:16-31) : le
 * `.env.example` a la racine ne mentionne ni CAPTURE_TOKEN, ni NTFY_*, ni
 * LIVRAISON. Un bloc equivalent y est ajoute EN PLUS, pas a la place.
 *
 *   LIVRAISON_PEREMPTION          « off » desactive le balayage. Defaut : on.
 *   LIVRAISON_PEREMPTION_CRON     planning cron. Defaut : 22:20 UTC.
 *   LIVRAISON_PEREMPTION_JOURS    jours d'attente avant la question. 1 a 365,
 *                                 defaut 21. Un seuil est un JUGEMENT : trop
 *                                 bas il archive de l'utile, trop haut il
 *                                 laisse la file pourrir. Il se regle sans
 *                                 redeploiement de code.
 *   LIVRAISON_PEREMPTION_GRACE    jours de silence apres la question avant
 *                                 l'archivage. 0 a 90, defaut 7.
 *   LIVRAISON_PEREMPTION_SILENCE  « off » retire l'archivage sur silence ; la
 *                                 question, elle, continue de partir. C'est le
 *                                 seul interrupteur du seul changement de
 *                                 comportement reel de ce chantier.
 *   LIVRAISON_PEREMPTION_MAX      archivages par passage. 1 a 50, defaut 5.
 *                                 Un writeFile vaut un commit et un push.
 */
const DEFAULT_SCHEDULE = '20 22 * * *';

export function schedulePeremption(service: PeremptionService): boolean {
  if ((process.env.LIVRAISON_PEREMPTION || 'on').toLowerCase() === 'off') {
    logger.info('Peremption disabled (LIVRAISON_PEREMPTION=off)');
    return false;
  }
  const schedule = process.env.LIVRAISON_PEREMPTION_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    logger.error('Invalid LIVRAISON_PEREMPTION_CRON : peremption not scheduled', { schedule });
    return false;
  }
  cron.schedule(schedule, () => {
    service
      .run()
      .then(r => {
        pouls.marque('peremption', true);
        logger.info('Peremption passe', {
          examines: r.examines,
          dormants: r.dormants,
          demandee: r.demandee,
          archivees: r.archivees.length,
        });
      })
      .catch(error => {
        pouls.marque('peremption', false, String(error));
        logger.error('Peremption failed', { error: String(error) });
      });
  });
  logger.info('Peremption scheduled', { schedule });
  return true;
}
