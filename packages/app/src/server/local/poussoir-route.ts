import type { Express, Request, Response } from 'express';
import type { PoussoirService } from '@/services/poussoir/poussoir';
import { logger } from '@/utils/logger';

/**
 * One-thumb surface for the poussoir. GET /poussoir shows THE gesture of the
 * day (fully prepared, ready to copy), one big "Fait" button, one small
 * "Passer" link. Token-gated like /revue (?k=TOKEN); disabled without
 * CAPTURE_TOKEN. GET because ntfy taps and phone browsers only speak GET;
 * the service enforces ONE consumption per Montreal day, so a reloaded tab
 * or a double tap cannot burn tomorrow's gesture.
 */

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function page(titre: string, corps: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0f14"><title>${escapeHtml(titre)}</title>
<style>
  body{background:#0b0f14;color:#e6edf3;font-family:system-ui,sans-serif;margin:0;padding:24px;line-height:1.5}
  .carte{max-width:640px;margin:0 auto;background:#11161d;border:1px solid #1f2630;border-radius:12px;padding:20px}
  h1{font-size:20px;margin:0 0 4px}
  .serie{color:#9da7b3;font-size:14px;margin-bottom:16px}
  pre{white-space:pre-wrap;word-wrap:break-word;background:#0b0f14;border:1px solid #1f2630;border-radius:8px;padding:14px;font-size:15px;font-family:inherit}
  .fait{display:block;text-align:center;background:#238636;color:#fff;text-decoration:none;font-size:18px;font-weight:600;padding:14px;border-radius:10px;margin-top:16px}
  .passer{display:block;text-align:center;color:#9da7b3;text-decoration:none;font-size:13px;margin-top:14px}
  .sub{color:#9da7b3}
</style></head><body><div class="carte">${corps}</div></body></html>`;
}

export function registerPoussoirRoutes(app: Express, poussoir: PoussoirService): boolean {
  const token = process.env.CAPTURE_TOKEN;
  if (!token) {
    logger.info('CAPTURE_TOKEN not set: poussoir surface disabled');
    return false;
  }
  const garde = (req: Request, res: Response): boolean => {
    if ((req.query.k as string | undefined) !== token) {
      res.status(401).type('text/plain').send('invalid token');
      return false;
    }
    return true;
  };
  const q = encodeURIComponent(token);

  app.get('/poussoir', async (req: Request, res: Response) => {
    if (!garde(req, res)) return;
    try {
      const { geste, etat } = await poussoir.courant();
      if (!geste) {
        res
          .type('text/html')
          .send(
            page(
              'Poussoir',
              `<h1>File vide 🎉</h1><p class="sub">Aucun geste en attente. Demande au cerveau d’en préparer d’autres.</p>`,
            ),
          );
        return;
      }
      res.type('text/html').send(
        page(
          'Geste du jour',
          `<h1>${escapeHtml(geste.titre)}</h1>
           <p class="serie">Série : ${etat.serie} jour(s). Copie, envoie, appuie sur Fait.</p>
           <pre>${escapeHtml(geste.corps)}</pre>
           <a class="fait" href="/poussoir/fait?k=${q}">✅ Fait, c’est parti</a>
           <a class="passer" href="/poussoir/passe?k=${q}">Passer (la série retombe à zéro)</a>`,
        ),
      );
    } catch (error) {
      logger.error('poussoir page failed', { error: String(error) });
      res.status(500).type('text/plain').send('erreur');
    }
  });

  app.get('/poussoir/fait', async (req: Request, res: Response) => {
    if (!garde(req, res)) return;
    try {
      const r = await poussoir.fait();
      res.type('text/html').send(
        r.ok
          ? page(
              'Fait',
              `<h1>Envoyé. 🔥</h1><p class="serie">Série : ${r.serie} jour(s).</p>
               <p class="sub">${escapeHtml(r.titre ?? '')}</p>
               <a class="passer" href="/poussoir?k=${q}">← Retour au poussoir</a>`,
            )
          : r.dejaTraite
            ? page(
                'Déjà traité',
                `<h1>Déjà traité aujourd’hui. ✅</h1>
                 <p class="sub">Le geste du jour est réglé (série : ${r.serie}). Le prochain arrive demain matin.</p>`,
              )
            : page('Poussoir', `<h1>Rien à cocher</h1><p class="sub">La file est vide.</p>`),
      );
    } catch (error) {
      logger.error('poussoir fait failed', { error: String(error) });
      res.status(500).type('text/plain').send('erreur');
    }
  });

  app.get('/poussoir/passe', async (req: Request, res: Response) => {
    if (!garde(req, res)) return;
    try {
      const r = await poussoir.passe();
      res.type('text/html').send(
        r.ok
          ? page(
              'Passé',
              `<h1>Passé.</h1><p class="sub">${escapeHtml(r.titre ?? '')} : retiré de la file. La série repart de zéro.</p>
               <a class="passer" href="/poussoir?k=${q}">← Voir le prochain geste</a>`,
            )
          : r.dejaTraite
            ? page(
                'Déjà traité',
                `<h1>Déjà traité aujourd’hui.</h1>
                 <p class="sub">Un geste a déjà été réglé ce jour. Le prochain arrive demain matin.</p>`,
              )
            : page('Poussoir', `<h1>Rien à passer</h1><p class="sub">La file est vide.</p>`),
      );
    } catch (error) {
      logger.error('poussoir passe failed', { error: String(error) });
      res.status(500).type('text/plain').send('erreur');
    }
  });

  logger.info('Poussoir surface registered at GET /poussoir');
  return true;
}
