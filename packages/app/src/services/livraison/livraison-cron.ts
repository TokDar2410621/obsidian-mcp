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
 *
 * Les variables de ce perimetre, documentees ICI parce que c'est la convention
 * reelle du depot (relance-cron.ts:9-12) : `.env.example` ne mentionne ni
 * CAPTURE_TOKEN, ni NTFY_*, ni LIVRAISON.
 *
 *   LIVRAISON                 « off » desactive le passage. Defaut : on.
 *   LIVRAISON_CRON            planning cron. Defaut : toutes les 5 minutes.
 *   LIVRABLE_SECRET           clef de signature des liens de livrable. Absente,
 *                             elle est derivee du CAPTURE_TOKEN avec separation
 *                             de domaine. Sans ni l'une ni l'autre, aucun lien
 *                             n'est signe et /livrable ne se monte pas.
 *   LIVRAISON_LIEN_JOURS      duree de vie d'un lien signe. Defaut : 7. En
 *                             JOURS, jamais en minutes : ntfy va chercher la
 *                             piece jointe a l'exterieur et le telephone la
 *                             recharge quand Darius ouvre la notif, des heures
 *                             plus tard. Une TTL courte donne une image morte.
 *   LIVRAISON_MAX_ANNONCES    pushes par passage. Defaut : 3.
 *   LIVRAISON_MAX_FERMETURES  ecritures eager par passage. Defaut : 10.
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
        // `amorcees` : le tout premier passage inscrit sans agir. Il ne
        // remplit ni annoncees ni fermees, donc la condition reste juste.
        if (r.annoncees + r.fermees + r.questions > 0) logger.info('Livraison passe', { ...r });
        else if (r.amorcees > 0) logger.info('Livraison amorcee', { ...r });
      })
      .catch(error => {
        pouls.marque('livraison', false, String(error));
        logger.error('Livraison failed', { error: String(error) });
      });
  });
  logger.info('Livraison scheduled', { schedule });
  return true;
}
