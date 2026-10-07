import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { VaultManager } from '@/services/vault-manager';
import { toVaultRelativePath } from '@/services/vault-manager';
import { estJetonLocal, jetonLocalConfigure } from '@/services/securite/appelant';
import { DOSSIER_SKILLS } from '@/services/skills/skills-service';
import { logger } from '@/utils/logger';

/**
 * POST /admin/skills-catalog : la synchro du catalogue de skills ecrit
 * `09-skills/` en UN commit (spec du 2026-10-07, §2.2).
 *
 * Pourquoi une route et pas cent appels create-note : chaque create-note est
 * un commit et un push. Cent commits d'affilee courent contre les pushes des
 * workers PC2, exactement la tempete qui les a fait tomber trois jours de
 * suite en juillet. Le serveur reste le seul ecrivain (regle « ecrire via le
 * serveur, jamais en git direct ») et assainit les em-dash a l'ecriture.
 *
 * Gardee par le jeton local (CERVEAU_JETON_LOCAL) : ni claude.ai ni un ami
 * ne peuvent l'appeler. Montee AVANT le parseur JSON global, qui plafonne a
 * 100 ko : un catalogue pese plusieurs megaoctets.
 */

const MAX_FICHIERS = 3000;
const MAX_OCTETS = 20 * 1024 * 1024;

export function registerSkillsCatalogRoute(
  app: Express,
  vault: VaultManager,
  apresEcriture?: () => Promise<unknown>,
): boolean {
  if (!jetonLocalConfigure()) {
    logger.info('CERVEAU_JETON_LOCAL absent : POST /admin/skills-catalog desactive');
    return false;
  }

  app.post(
    '/admin/skills-catalog',
    // Le jeton AVANT le parseur : sans lui, n'importe qui faisait analyser
    // 25 Mo de JSON au serveur perso a chaque requete (revue du 2026-10-07).
    (req: Request, res: Response, next: NextFunction) => {
      const entete = req.headers.authorization ?? '';
      if (!entete.startsWith('Bearer ') || !estJetonLocal(entete.substring(7))) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    },
    express.json({ limit: '25mb' }),
    async (req: Request, res: Response) => {
      if (!vault.remplacerDossier) {
        res.status(501).json({ error: 'ce coffre ne sait pas remplacer un dossier en un commit' });
        return;
      }

      const fichiers = (req.body as { fichiers?: unknown })?.fichiers;
      if (!Array.isArray(fichiers) || fichiers.length === 0 || fichiers.length > MAX_FICHIERS) {
        res.status(400).json({ error: `fichiers : tableau de 1 a ${MAX_FICHIERS} entrees attendu` });
        return;
      }
      const propres: Array<{ chemin: string; contenu: string }> = [];
      let octets = 0;
      for (const f of fichiers as Array<Record<string, unknown>>) {
        if (typeof f?.chemin !== 'string' || typeof f?.contenu !== 'string') {
          res.status(400).json({ error: 'chaque fichier exige chemin et contenu (chaines)' });
          return;
        }
        let rel: string;
        try {
          rel = toVaultRelativePath(f.chemin);
        } catch (error) {
          res.status(400).json({ error: String((error as Error).message) });
          return;
        }
        if (!rel.startsWith(`${DOSSIER_SKILLS}/`) || !rel.endsWith('.md')) {
          res.status(400).json({ error: `seuls les .md sous ${DOSSIER_SKILLS}/ sont acceptes : ${rel}` });
          return;
        }
        octets += Buffer.byteLength(f.contenu, 'utf8');
        propres.push({ chemin: rel, contenu: f.contenu });
      }
      if (octets > MAX_OCTETS) {
        res.status(413).json({ error: `catalogue trop lourd (${octets} octets)` });
        return;
      }

      try {
        const r = await vault.remplacerDossier(DOSSIER_SKILLS, propres, {
          message: `Catalogue de skills : ${propres.length} fichier(s)`,
        });
        logger.info('Catalogue de skills ecrit', r);
        // L'index des skills se met a jour au webhook ; ceci evite d'attendre.
        apresEcriture?.().catch(error =>
          logger.error('Index des skills : rafraichissement en echec', { error: String(error) }),
        );
        res.json({ ok: true, ...r });
      } catch (error) {
        logger.error('Catalogue de skills : ecriture en echec', { error: String(error) });
        res.status(500).json({ error: 'ecriture du catalogue en echec' });
      }
    },
  );
  logger.info('POST /admin/skills-catalog enregistre (jeton local)');
  return true;
}
