import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { PoussoirService } from '@/services/poussoir/poussoir';
import { PubliarClient } from '@/services/poussoir/publiar-client';
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

/**
 * A gesture section MAY end with a fenced visual brief:
 *
 *     ```visuel
 *     { "archetype": "tool_pairing", ... }
 *     ```
 *
 * The block is the LeadMagnetVisualSpec that Publiar renders. It is stripped
 * from the copyable text (nobody pastes JSON into LinkedIn) and powers the
 * Accepter chain: accept -> server renders -> Darius validates -> publish.
 */
function extraireVisuel(corps: string): { texte: string; spec: Record<string, unknown> | null } {
  const m = corps.match(/```visuel\s*\n([\s\S]*?)```/);
  if (!m) return { texte: corps, spec: null };
  const texte = corps.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
  try {
    return { texte, spec: JSON.parse(m[1]) as Record<string, unknown> };
  } catch (error) {
    logger.warn('poussoir: bloc visuel illisible, ignore', { error: String(error) });
    return { texte, spec: null };
  }
}

/** Rendered previews awaiting Darius's tap. In-memory: one long-running container. */
interface Apercu {
  png: Buffer;
  texte: string;
  titre: string;
  publie?: string; // post_urn once published, guards double-tap
}
const apercus = new Map<string, Apercu>();

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
  const publiar = new PubliarClient();

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
      const { texte, spec } = extraireVisuel(geste.corps);
      const accepter =
        spec && publiar.configured()
          ? `<a class="fait" href="/poussoir/accepter?k=${q}">🎨 Accepter : préparer le visuel et publier</a>`
          : '';
      res.type('text/html').send(
        page(
          'Geste du jour',
          `<h1>${escapeHtml(geste.titre)}</h1>
           <p class="serie">Série : ${etat.serie} jour(s). Copie, envoie, appuie sur Fait.</p>
           <pre>${escapeHtml(texte)}</pre>
           ${accepter}
           <a class="fait" href="/poussoir/fait?k=${q}">✅ J’ai publié ce geste</a>
           <a class="passer" href="/poussoir/passe?k=${q}">❌ Je saute aujourd’hui (la série repart à zéro)</a>`,
        ),
      );
    } catch (error) {
      logger.error('poussoir page failed', { error: String(error) });
      res.status(500).type('text/plain').send('erreur');
    }
  });

  // ── La chaîne Accepter : rendre le visuel, faire valider, publier ─────────
  //
  // Accepter = « je veux que ce geste parte ». Le serveur rend le brief visuel
  // de la section via Publiar, montre l'aperçu, et NE publie qu'au tap suivant.
  // Ce second tap est la validation qu'exige la règle du vault : le cerveau
  // prépare, Darius envoie. Refuser la direction reste possible à l'aperçu.
  app.get('/poussoir/accepter', async (req: Request, res: Response) => {
    if (!garde(req, res)) return;
    try {
      const { geste } = await poussoir.courant();
      if (!geste) {
        res.type('text/html').send(page('Poussoir', `<h1>File vide</h1><p class="sub">Rien à accepter.</p>`));
        return;
      }
      const { texte, spec } = extraireVisuel(geste.corps);
      if (!publiar.configured()) {
        res.type('text/html').send(
          page(
            'Publiar absent',
            `<h1>PUBLIAR_API_KEY manquante</h1>
             <p class="sub">Le serveur ne peut ni rendre le visuel ni publier sans elle. Ajoute la variable sur Railway, ou publie à la main puis appuie sur Fait.</p>
             <a class="passer" href="/poussoir?k=${q}">← Retour au geste</a>`,
          ),
        );
        return;
      }
      if (!spec) {
        res.type('text/html').send(
          page(
            'Pas de brief visuel',
            `<h1>Ce geste n’a pas de brief visuel</h1>
             <p class="sub">Sa section dans _poussoir.md ne porte pas de bloc <code>visuel</code>. Publie à la main, ou demande au cerveau d’en préparer un.</p>
             <a class="passer" href="/poussoir?k=${q}">← Retour au geste</a>`,
          ),
        );
        return;
      }
      const png = await publiar.renderVisual(spec);
      const id = randomUUID();
      apercus.set(id, { png, texte, titre: geste.titre });
      // Un seul aperçu vivant à la fois : les précédents ne sont plus atteignables.
      for (const [k] of apercus) if (k !== id) apercus.delete(k);
      res.type('text/html').send(
        page(
          'Valider le visuel',
          `<h1>${escapeHtml(geste.titre)}</h1>
           <p class="sub">Voici le visuel rendu. Rien n’est parti : c’est TOI qui publies.</p>
           <img style="width:100%;border-radius:8px;border:1px solid #1f2630" alt="visuel proposé"
                src="data:image/png;base64,${png.toString('base64')}"/>
           <a class="fait" href="/poussoir/accepter/publier?k=${q}&id=${id}">🚀 Publier maintenant sur LinkedIn</a>
           <a class="passer" href="/poussoir?k=${q}">🔁 Autre direction : réponds en capture « direction: ... » et le cerveau régénère le brief</a>
           <a class="passer" href="/poussoir/fait?k=${q}">✅ Je publierai moi-même (marquer Fait)</a>`,
        ),
      );
    } catch (error) {
      logger.error('poussoir accepter failed', { error: String(error) });
      res
        .status(500)
        .type('text/html')
        .send(
          page(
            'Rendu impossible',
            `<h1>Le rendu du visuel a échoué</h1><p class="sub">${escapeHtml(String(error))}</p>
             <a class="passer" href="/poussoir?k=${q}">← Retour au geste</a>`,
          ),
        );
    }
  });

  app.get('/poussoir/accepter/publier', async (req: Request, res: Response) => {
    if (!garde(req, res)) return;
    const id = String(req.query.id ?? '');
    const apercu = apercus.get(id);
    if (!apercu) {
      res.type('text/html').send(
        page(
          'Aperçu expiré',
          `<h1>Aperçu introuvable</h1><p class="sub">Le serveur a peut-être redémarré. Repasse par Accepter.</p>
           <a class="passer" href="/poussoir/accepter?k=${q}">← Régénérer l’aperçu</a>`,
        ),
      );
      return;
    }
    // Onglet restauré ou double tap : la publication ne part qu'une fois.
    if (apercu.publie) {
      res.type('text/html').send(
        page('Déjà publié', `<h1>Déjà publié. ✅</h1><p class="sub">${escapeHtml(apercu.publie)}</p>`),
      );
      return;
    }
    try {
      apercu.publie = 'en cours';
      const r = await publiar.publish({
        content: apercu.texte,
        image_base64: apercu.png.toString('base64'),
      });
      const urn = typeof r.post_urn === 'string' ? r.post_urn : '';
      apercu.publie = urn || 'publié';
      const f = await poussoir.fait();
      res.type('text/html').send(
        page(
          'Publié',
          `<h1>Publié. 🔥</h1>
           <p class="serie">Série : ${f.serie} jour(s).</p>
           <p class="sub">${escapeHtml(apercu.titre)}${urn ? `<br/>URN : ${escapeHtml(urn)}` : ''}</p>
           <p class="sub">Pense au suivi : enregistre ce post dans Publiar (register_published) pour que ses commentaires aient une cible.</p>`,
        ),
      );
    } catch (error) {
      apercu.publie = undefined;
      logger.error('poussoir publier failed', { error: String(error) });
      res
        .status(500)
        .type('text/html')
        .send(
          page(
            'Publication échouée',
            `<h1>La publication a échoué</h1><p class="sub">${escapeHtml(String(error))}</p>
             <a class="fait" href="/poussoir/accepter/publier?k=${q}&id=${id}">Réessayer</a>
             <a class="passer" href="/poussoir?k=${q}">← Retour au geste</a>`,
          ),
        );
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

  // Sauter se confirme : le premier lien affiche une page, seul le second agit.
  // Raison : le 2026-08-30 Darius a publie le geste PUIS tape « Passer » en
  // croyant declarer la publication (« passer un post » = le publier, en
  // francais d'ici). Un seul GET a remis sa serie a zero pour un travail fait.
  app.get('/poussoir/passe', async (req: Request, res: Response) => {
    if (!garde(req, res)) return;
    try {
      const { geste } = await poussoir.courant();
      if (!geste) {
        res.type('text/html').send(page('Poussoir', `<h1>Rien à sauter</h1><p class="sub">La file est vide.</p>`));
        return;
      }
      res.type('text/html').send(
        page(
          'Sauter ?',
          `<h1>Sauter ce geste ?</h1>
           <p class="sub">« ${escapeHtml(geste.titre)} » ne sera PAS publié et ta série repart à zéro.<br/>
           Si tu l’as publié, c’est le bouton vert qu’il te faut.</p>
           <a class="fait" href="/poussoir/fait?k=${q}">✅ Non, je l’ai publié</a>
           <a class="passer" href="/poussoir/passe/confirme?k=${q}">❌ Oui, je saute (série à zéro)</a>`,
        ),
      );
    } catch (error) {
      logger.error('poussoir passe (confirmation) failed', { error: String(error) });
      res.status(500).type('text/plain').send('erreur');
    }
  });

  app.get('/poussoir/passe/confirme', async (req: Request, res: Response) => {
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
