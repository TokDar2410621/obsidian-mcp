import type { Express, Request, Response } from 'express';
import type { VaultManager } from '@/services/vault-manager';
import { readBinary } from '@/services/vault-manager';
import type { BucketStore } from '@/services/storage/bucket-store';
import { contentDispositionFor } from '@/services/storage/bucket-store';
import { secretLivrable, ttlSecondes, verifier } from '@/services/livraison/lien-signe';
import {
  PREFIXE_BUCKET,
  RANGS,
  cheminServable,
  extensionDe,
  nomFichier,
  typeMime,
} from '@/services/livraison/piece-jointe';
import { logger } from '@/utils/logger';

/**
 * Les deux routes par lesquelles un livrable ARRIVE, au lieu d'etre nomme.
 *
 *   GET /livrable      les octets. C'est la cible de `attach` : ntfy va les
 *                      chercher et le telephone affiche l'image.
 *   GET /livrable/vue  la page. C'est la cible de `click` : un tap ouvre le
 *                      hero, la note, l'affiche.
 *
 * Aucune des deux ne porte de jeton. Elles sont gardees par la SIGNATURE du
 * lien (f, e, s), pas par le `CAPTURE_TOKEN`, qui circule deja trop et qu'un
 * audit a signale. Consequence directe : la page de vue ne porte AUCUN bouton
 * Valider ou Rejeter, parce qu'ils exigeraient le jeton. Ces boutons vivent
 * dans les `actions` de la notification, ou ils existent deja.
 *
 * La signature prouve l'ORIGINE du lien, jamais le DROIT de lire. Les zones
 * sensibles sont donc refusees DEUX fois : a la signature (on ne signe jamais
 * `00-personnel/`) et ici, a chaque requete. Une zone qui devient sensible
 * apres coup ferme ainsi les liens deja emis.
 */

// Le prefixe vit desormais dans piece-jointe.ts, qui decide AUSSI si une cle
// de bucket est servable : une seule definition, pas deux qui derivent.

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const CSS = `*{box-sizing:border-box}
body{margin:0;background:#0b0f14;color:#e6edf3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:19px;margin:8px 0 4px}
.sub{color:#7d8896;font-size:13px;margin:0 0 16px;word-break:break-all}
img.vue{display:block;width:100%;height:auto;border-radius:12px;background:#0f1620}
iframe.vue{display:block;width:100%;height:78vh;border:1px solid #1f2937;border-radius:12px;background:#fff}
article.txt{display:block;white-space:pre-wrap;word-wrap:break-word;background:#0f1620;border:1px solid #1f2937;border-radius:12px;padding:16px;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c7d0da}
a.dl{display:inline-block;margin-top:18px;color:#3b82f6;text-decoration:none;font-size:15px}
p.pied{color:#7d8896;font-size:13px;margin-top:22px;border-top:1px solid #1f2937;padding-top:14px}`;

function page(titre: string, corps: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0f14"><title>${escapeHtml(titre)}</title>
<style>${CSS}</style></head><body><main>${corps}</main></body></html>`;
}

/** Une cle de bucket servable : pas de traversee, une extension connue. */
function cleBucketServable(cle: string): boolean {
  if (!cle || cle.includes('..') || cle.startsWith('/')) return false;
  return extensionDe(cle) in RANGS;
}

/** Un nom de fichier sur pour un en-tete Content-Disposition. */
function nomEntete(chemin: string): string {
  return nomFichier(chemin).replace(/[^A-Za-z0-9._ -]/g, '_');
}

export function registerLivrableRoute(
  app: Express,
  vault: VaultManager,
  bucket: BucketStore | null = null,
): boolean {
  if (!secretLivrable()) {
    logger.info('Livrable routes disabled: no LIVRABLE_SECRET nor CAPTURE_TOKEN');
    return false;
  }

  /**
   * La garde commune. Rend le chemin quand le lien est bon, null sinon (la
   * reponse est deja envoyee). L'ordre des verdicts vient de lien-signe.ts :
   * signature d'abord, expiration ensuite.
   */
  const garde = (req: Request, res: Response): string | null => {
    const f = String(req.query.f ?? '');
    const e = String(req.query.e ?? '');
    const s = String(req.query.s ?? '');
    const verdict = verifier(f, e, s);
    if (verdict === 'desactive') {
      res.status(404).type('text/plain').send('livrable indisponible');
      return null;
    }
    if (verdict === 'invalide') {
      res.status(403).type('text/plain').send('lien invalide');
      return null;
    }
    if (verdict === 'expire') {
      res
        .status(410)
        .type('text/html')
        .send(
          page(
            'Lien expiré',
            `<h1>Ce lien a expiré</h1>
             <p class="sub">Un lien de livrable vit quelques jours, puis se ferme.</p>
             <p>Ouvre la revue depuis la notification, ou redemande le livrable.</p>`,
          ),
        );
      return null;
    }
    // On REVALIDE apres la signature : elle prouve l'origine, pas le droit.
    const ok = f.startsWith(PREFIXE_BUCKET)
      ? cleBucketServable(f.slice(PREFIXE_BUCKET.length))
      : cheminServable(f);
    if (!ok) {
      res.status(403).type('text/plain').send('chemin refusé');
      return null;
    }
    return f;
  };

  const urlBrute = (req: Request): string => {
    const q = [
      `f=${encodeURIComponent(String(req.query.f ?? ''))}`,
      `e=${encodeURIComponent(String(req.query.e ?? ''))}`,
      `s=${encodeURIComponent(String(req.query.s ?? ''))}`,
    ].join('&');
    return `/livrable?${q}`;
  };

  /**
   * Page 404 lisible. JAMAIS String(error) dans le corps :
   * `GitVaultManager.readFile` met le chemin DISQUE complet du serveur dans son
   * message d'erreur. Et le cas est reel : onze images seulement sont suivies
   * par git, donc un livrable present sur PC1 peut etre absent du clone serveur.
   */
  const pageIntrouvable = (chemin: string): string =>
    page(
      'Livrable introuvable',
      `<h1>Ce livrable n'est pas sur le serveur</h1>
       <p class="sub">${escapeHtml(chemin)}</p>
       <p>Le fichier existe peut-être sur le PC qui l'a produit sans être suivi
       par git : le clone du serveur ne le voit alors pas.</p>`,
    );

  // --- les octets ---------------------------------------------------------
  app.get('/livrable', async (req: Request, res: Response) => {
    const f = garde(req, res);
    if (f === null) return;

    if (f.startsWith(PREFIXE_BUCKET)) {
      if (!bucket) {
        res.status(404).type('text/plain').send('bucket non configuré');
        return;
      }
      try {
        res.redirect(302, await bucket.presignGet(f.slice(PREFIXE_BUCKET.length), ttlSecondes()));
      } catch (error) {
        logger.warn('Livrable bucket presign failed', { error: String(error) });
        res.status(404).type('text/html').send(pageIntrouvable(f));
      }
      return;
    }

    let octets: Buffer;
    try {
      octets = await readBinary(vault, f);
    } catch (error) {
      logger.warn('Livrable introuvable', { chemin: f, error: String(error) });
      res.status(404).type('text/html').send(pageIntrouvable(f));
      return;
    }
    const mime = typeMime(f);
    res.setHeader('Content-Type', mime);
    // Un .md, un .html, un .py se TELECHARGENT, ils ne s'executent pas dans
    // l'origine du serveur, ou vivent /valide et /rejette.
    const disposition = contentDispositionFor(mime);
    if (disposition) {
      res.setHeader('Content-Disposition', `${disposition}; filename="${nomEntete(f)}"`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(octets);
  });

  // --- la page ------------------------------------------------------------
  app.get('/livrable/vue', async (req: Request, res: Response) => {
    const f = garde(req, res);
    if (f === null) return;

    const nom = nomFichier(f.startsWith(PREFIXE_BUCKET) ? f.slice(PREFIXE_BUCKET.length) : f);
    const brute = urlBrute(req);
    const pied =
      '<p class="pied">Pour valider ou rejeter, utilise les boutons de la notification.</p>';
    const telecharger = `<a class="dl" href="${escapeHtml(brute)}">Télécharger le fichier</a>`;
    const ext = extensionDe(f);

    const enTete = `<h1>${escapeHtml(nom)}</h1><p class="sub">${escapeHtml(f)}</p>`;

    // Une image, un PDF, un bucket : rien a lire, on pointe la route brute.
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      res
        .type('text/html')
        .send(
          page(nom, `${enTete}<img class="vue" src="${escapeHtml(brute)}" alt="${escapeHtml(nom)}">${telecharger}${pied}`),
        );
      return;
    }
    if (ext === 'pdf' || f.startsWith(PREFIXE_BUCKET)) {
      res
        .type('text/html')
        .send(page(nom, `${enTete}<iframe class="vue" src="${escapeHtml(brute)}"></iframe>${telecharger}${pied}`));
      return;
    }

    let contenu: string;
    try {
      contenu = (await readBinary(vault, f)).toString('utf8');
    } catch (error) {
      logger.warn('Livrable introuvable (vue)', { chemin: f, error: String(error) });
      res.status(404).type('text/html').send(pageIntrouvable(f));
      return;
    }

    if (ext === 'html') {
      // « Voir physiquement le hero » est la demande litterale : du source
      // echappe ne la remplit pas. L'attribut sandbox est NU, sans aucun jeton,
      // donc sans allow-same-origin et sans allow-scripts : la page s'affiche,
      // son script ne tourne pas et ne peut rien lire de l'origine du serveur.
      res
        .type('text/html')
        .send(
          page(
            nom,
            `${enTete}<iframe class="vue" sandbox srcdoc="${escapeHtml(contenu)}"></iframe>${telecharger}${pied}`,
          ),
        );
      return;
    }

    // Markdown, code, texte : echappe en pre-wrap, exactement comme /note.
    // Un <script> dans une note apparait en &lt;script&gt;.
    res
      .type('text/html')
      .send(page(nom, `${enTete}<article class="txt">${escapeHtml(contenu)}</article>${telecharger}${pied}`));
  });

  logger.info('Livrable routes registered (/livrable, /livrable/vue)');
  return true;
}
