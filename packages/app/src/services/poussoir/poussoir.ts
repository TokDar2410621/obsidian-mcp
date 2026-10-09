import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
import type { NotifyPusher } from '@/services/notify/notifier';
import { logger } from '@/utils/logger';

/**
 * Poussoir: ONE prepared visibility gesture per day, pushed to Darius's
 * phone, verified in the evening, with a streak on the line.
 *
 * The honest premise: nobody can force a human to act. What works is
 * engineering the conditions (all deliberate, all visible to Darius):
 *  - ONE gesture, not a list (a list is a place where actions hide);
 *  - 100% prepared (the text is written; the remaining act is "open, copy,
 *    send": two minutes);
 *  - it comes back until done (skipping is possible but resets the streak:
 *    loss aversion is the only teeth self-report allows);
 *  - the evening relance makes the dodge VISIBLE instead of silent;
 *  - PAST `SEUIL_JOURS_POURQUOI` days sitting unconsumed, it stops coming
 *    back: repeating a reminder that never lands is harcelement, not a
 *    nudge (regle `blocage-demander-pourquoi`, "la question n'est jamais
 *    reposee deux fois"). The gesture is retired (Passe), ONE distinct
 *    "pourquoi" push replaces the usual one, and the queue moves on.
 *
 * Queue: 08-auto/_poussoir.md, one `## Title` section per gesture, body =
 * the fully-prepared content. A section is consumed when its body carries a
 * final `**Fait le YYYY-MM-DD.**` or `**Passé le YYYY-MM-DD.**` line (visible
 * in Obsidian, greppable, no hidden state). The CURRENT gesture is the first
 * unconsumed section. State (streak, last send) in _poussoir-state.json.
 *
 * Day boundaries use America/Montreal: Darius acts in the evening EASTERN
 * time; a UTC day boundary would break a perfectly honest streak.
 */

const FICHIER = '08-auto/_poussoir.md';
const ETAT = '08-auto/_poussoir-state.json';

/** Jours consecutifs sans suite avant de cesser de repousser un geste
 *  (regle blocage-demander-pourquoi : la question ne se repose jamais
 *  deux fois, donc on ne rappelle pas indefiniment non plus). */
const SEUIL_JOURS_POURQUOI = 3;

/** Difference en jours calendaires entre deux jours Montreal (YYYY-MM-DD). */
function diffJours(depuis: string, jusqua: string): number {
  const [ay, am, ad] = depuis.split('-').map(Number);
  const [by, bm, bd] = jusqua.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export interface Geste {
  titre: string;
  corps: string;
  /** Char offset of the section end in the queue file (insertion point). */
  fin: number;
}

export interface EtatPoussoir {
  version: 1;
  serie: number;
  /** Montreal day (YYYY-MM-DD) of the last DONE gesture. */
  dernierFait: string | null;
  /** Montreal day of the last gesture CONSUMED (fait OR passe): one a day. */
  dernierTraite: string | null;
  /** ISO datetime of the last morning send. */
  dernierEnvoi: string | null;
  /** Montreal day of the last evening relance (one per evening, max). */
  derniereRelance: string | null;
  /** Montreal day of the last "queue empty" nudge (one per day, max). */
  dernierVide: string | null;
  /** Titre of the gesture currently served: detects when the queue moved on. */
  gesteCourantTitre: string | null;
  /** Montreal day THIS gesture (same titre) was first served. */
  gesteCourantDepuis: string | null;
}

export interface PoussoirDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  baseUrl?: string;
  token?: string | null;
  now?: () => Date;
}

const CONSOMME = /^\*\*(Fait|Passé) le \d{4}-\d{2}-\d{2}\.\*\*\s*$/m;

/** Montreal calendar day of a Date, as YYYY-MM-DD. */
export function jourMontreal(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Montreal' });
}

function veilleMontreal(d: Date): string {
  return jourMontreal(new Date(d.getTime() - 24 * 3_600_000));
}

/** Parse the queue: every section, with the first unconsumed one first. */
export function parseFile(contenu: string): { gestes: Geste[]; courant: Geste | null } {
  const gestes: Geste[] = [];
  const regex = /^## +(.+)$/gm;
  const bornes: Array<{ titre: string; debut: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(contenu)) !== null) bornes.push({ titre: m[1].trim(), debut: m.index });
  for (let i = 0; i < bornes.length; i++) {
    const fin = i + 1 < bornes.length ? bornes[i + 1].debut : contenu.length;
    const bloc = contenu.slice(bornes[i].debut, fin);
    const corps = bloc.replace(/^## +.+\r?\n?/, '').trim();
    gestes.push({ titre: bornes[i].titre, corps, fin });
  }
  const courant = gestes.find(g => !CONSOMME.test(g.corps)) ?? null;
  return { gestes, courant };
}

export class PoussoirService {
  constructor(private readonly deps: PoussoirDeps) {}

  private get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private lien(): string | undefined {
    const { baseUrl, token } = this.deps;
    if (!baseUrl || !token) return undefined;
    return `${baseUrl}/poussoir?k=${encodeURIComponent(token)}`;
  }

  private async lireEtat(): Promise<EtatPoussoir> {
    const vide: EtatPoussoir = {
      version: 1,
      serie: 0,
      dernierFait: null,
      dernierTraite: null,
      dernierEnvoi: null,
      derniereRelance: null,
      dernierVide: null,
      gesteCourantTitre: null,
      gesteCourantDepuis: null,
    };
    try {
      const brut = JSON.parse(await this.deps.vault.readFile(ETAT)) as Partial<EtatPoussoir>;
      return {
        ...vide,
        serie: typeof brut.serie === 'number' && brut.serie >= 0 ? brut.serie : 0,
        dernierFait: typeof brut.dernierFait === 'string' ? brut.dernierFait : null,
        dernierTraite:
          typeof brut.dernierTraite === 'string'
            ? brut.dernierTraite
            : typeof brut.dernierFait === 'string'
              ? brut.dernierFait
              : null,
        dernierEnvoi: typeof brut.dernierEnvoi === 'string' ? brut.dernierEnvoi : null,
        derniereRelance: typeof brut.derniereRelance === 'string' ? brut.derniereRelance : null,
        dernierVide: typeof brut.dernierVide === 'string' ? brut.dernierVide : null,
        gesteCourantTitre: typeof brut.gesteCourantTitre === 'string' ? brut.gesteCourantTitre : null,
        gesteCourantDepuis: typeof brut.gesteCourantDepuis === 'string' ? brut.gesteCourantDepuis : null,
      };
    } catch {
      return vide;
    }
  }

  private async ecrireEtat(etat: EtatPoussoir): Promise<void> {
    await writeStateFile(this.deps.vault, ETAT, JSON.stringify(etat, null, 2));
  }

  async courant(): Promise<{ geste: Geste | null; etat: EtatPoussoir }> {
    const etat = await this.lireEtat();
    let contenu = '';
    try {
      contenu = await this.deps.vault.readFile(FICHIER);
    } catch {
      /* queue absent = empty */
    }
    return { geste: parseFile(contenu).courant, etat };
  }

  /** Morning push: THE gesture of the day. One, prepared, two minutes. */
  async envoiMatin(): Promise<{ envoye: boolean; raison?: string }> {
    const now = this.now;
    const jour = jourMontreal(now);
    const { geste, etat } = await this.courant();

    if (!geste) {
      // Empty queue: nudge once a day, quietly. An empty pusher that stays
      // silent would be one more component sleeping without a scream.
      if (etat.dernierVide !== jour) {
        await this.deps.notify?.push({
          title: '🎯 Poussoir à sec',
          message:
            'Plus aucun geste préparé dans 08-auto/_poussoir.md. Demande au cerveau d’en préparer.',
          priority: 3,
          tags: ['warning'],
        });
        await this.ecrireEtat({ ...etat, dernierVide: jour });
      }
      return { envoye: false, raison: 'file vide' };
    }
    if (etat.dernierTraite === jour) return { envoye: false, raison: 'deja traite aujourd hui' };

    // Meme geste que la veille (par titre) : continue de compter ses jours.
    // Geste different (queue avancee, texte reecrit) : le compteur repart.
    const depuisGeste = etat.gesteCourantTitre === geste.titre ? etat.gesteCourantDepuis : null;
    const gesteCourantDepuis = depuisGeste ?? jour;
    const joursSansSuite = diffJours(gesteCourantDepuis, jour);

    if (joursSansSuite >= SEUIL_JOURS_POURQUOI) {
      // Regle blocage-demander-pourquoi : la question ne se repose jamais
      // deux fois. Un geste qui ne part pas apres plusieurs jours ne merite
      // plus un rappel, mais une question, puis le silence sur CE geste.
      await this.deps.notify?.push({
        title: '🤔 Ce geste dort, je le retire',
        message: `${geste.titre}\n\nServi ${joursSansSuite} jours sans suite. Je ne le repousse plus (regle blocage-demander-pourquoi) : dis pourquoi dans 08-auto/_poussoir.md, ou prepare-en un autre.`,
        priority: 4,
        tags: ['thinking'],
        ...(this.lien() ? { click: this.lien() } : {}),
      });
      await this.consommer('Passé');
      await this.ecrireEtat({
        ...etat,
        serie: 0,
        dernierTraite: jour,
        gesteCourantTitre: null,
        gesteCourantDepuis: null,
      });
      logger.info('poussoir: geste retire (dort)', { titre: geste.titre, joursSansSuite });
      return { envoye: true, raison: 'retire: dort depuis trop longtemps' };
    }

    // A missed day is said out loud: losing the streak must be FELT, else it
    // is not a streak, it is a counter.
    const seriePerdue =
      etat.serie > 0 && etat.dernierFait !== null && etat.dernierFait < veilleMontreal(now);
    const titre = seriePerdue
      ? `🎯 Geste du jour · série perdue (était ${etat.serie})`
      : `🎯 Geste du jour · série ${etat.serie}`;
    const extrait = geste.corps.replace(/\s+/g, ' ').slice(0, 180);
    await this.deps.notify?.push({
      title: titre,
      message: `${geste.titre}\n${extrait}\n\nTout est prêt : ouvre, copie, envoie. 2 minutes.`,
      priority: 4,
      tags: ['dart'],
      ...(this.lien() ? { click: this.lien() } : {}),
    });
    const serie = seriePerdue ? 0 : etat.serie;
    await this.ecrireEtat({
      ...etat,
      serie,
      dernierEnvoi: now.toISOString(),
      gesteCourantTitre: geste.titre,
      gesteCourantDepuis,
    });
    return { envoye: true };
  }

  /** Evening relance: the dodge becomes visible. Fires only if a morning send
   *  happened within 24h and the gesture is still not done. */
  async relanceSoir(): Promise<{ relance: boolean; raison?: string }> {
    const now = this.now;
    const jour = jourMontreal(now);
    const { geste, etat } = await this.courant();
    if (!geste) return { relance: false, raison: 'file vide' };
    if (!etat.dernierEnvoi) return { relance: false, raison: 'aucun envoi du matin' };
    const ageEnvoiH = (now.getTime() - Date.parse(etat.dernierEnvoi)) / 3_600_000;
    if (ageEnvoiH > 24 || ageEnvoiH < 0) return { relance: false, raison: 'envoi trop ancien' };
    const jourEnvoi = jourMontreal(new Date(Date.parse(etat.dernierEnvoi)));
    // Fait OU Passe : dans les deux cas Darius a repondu au geste du jour.
    // Relancer apres un Passer explicite serait du harcelement, pas un rappel.
    if (etat.dernierTraite !== null && etat.dernierTraite >= jourEnvoi)
      return { relance: false, raison: 'deja traite' };
    if (etat.derniereRelance === jour) return { relance: false, raison: 'deja relance ce soir' };

    await this.deps.notify?.push({
      title: '⏰ Le geste du jour attend encore',
      message: `${geste.titre}\n\n2 minutes, tout est écrit. Série en jeu : ${etat.serie} jour(s).`,
      priority: 5,
      tags: ['rotating_light'],
      ...(this.lien() ? { click: this.lien() } : {}),
    });
    await this.ecrireEtat({ ...etat, derniereRelance: jour });
    return { relance: true };
  }

  private async consommer(mot: 'Fait' | 'Passé'): Promise<Geste | null> {
    let contenu = '';
    try {
      contenu = await this.deps.vault.readFile(FICHIER);
    } catch {
      return null;
    }
    const { courant } = parseFile(contenu);
    if (!courant) return null;
    const jour = jourMontreal(this.now);
    const marque = `\n\n**${mot} le ${jour}.**\n`;
    const nouveau = contenu.slice(0, courant.fin).replace(/\s*$/, '') + marque + contenu.slice(courant.fin);
    // Direct write (not lazy): the confirmation page reads back immediately.
    await this.deps.vault.writeFile(FICHIER, nouveau);
    return courant;
  }

  /** Darius tapped "Fait": consume the gesture, grow the streak.
   *  ONE consumption a day, whatever the button: a reloaded tab or a double
   *  tap re-issues the GET (Chrome restores /poussoir/fait on memory resume)
   *  and would otherwise stamp TOMORROW's gesture sight unseen. */
  async fait(): Promise<{ ok: boolean; dejaTraite?: boolean; titre?: string; serie: number }> {
    const now = this.now;
    const jour = jourMontreal(now);
    const etat = await this.lireEtat();
    if (etat.dernierTraite === jour) return { ok: false, dejaTraite: true, serie: etat.serie };
    const geste = await this.consommer('Fait');
    if (!geste) return { ok: false, serie: etat.serie };
    const serie = etat.dernierFait === veilleMontreal(now) ? etat.serie + 1 : 1;
    await this.ecrireEtat({ ...etat, serie, dernierFait: jour, dernierTraite: jour });
    logger.info('poussoir: geste fait', { titre: geste.titre, serie });
    return { ok: true, titre: geste.titre, serie };
  }

  /** Darius tapped "Passer": consume WITHOUT credit; the streak resets.
   *  Same one-a-day guard as fait(). */
  async passe(): Promise<{ ok: boolean; dejaTraite?: boolean; titre?: string }> {
    const now = this.now;
    const jour = jourMontreal(now);
    const etat = await this.lireEtat();
    if (etat.dernierTraite === jour) return { ok: false, dejaTraite: true };
    const geste = await this.consommer('Passé');
    if (!geste) return { ok: false };
    await this.ecrireEtat({ ...etat, serie: 0, dernierTraite: jour });
    logger.info('poussoir: geste passe', { titre: geste.titre });
    return { ok: true, titre: geste.titre };
  }
}
