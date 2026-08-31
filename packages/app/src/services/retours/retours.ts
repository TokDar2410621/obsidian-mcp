import type { NotifyPusher } from '@/services/notify/notifier';
import type { VaultManager } from '@/services/vault-manager';
import { writeStateFile } from '@/services/vault-manager';
import { PubliarSuivi, type PostSuivi } from '@/services/retours/publiar-suivi';
import { logger } from '@/utils/logger';

/**
 * Retours du monde: the afferent nerve the cerveau lacked. The system had a
 * strong production side (posts, leads, tasks) and good interoception (the
 * battement watches the organs), but nothing read the WORLD's response:
 * 15 tracked posts, `last_polled_at: null` on every one, CTA keywords waiting
 * for comments nobody ever fetched.
 *
 * One pass a day, before the morning brief so the brief can quote it:
 *  1. list the tracked posts, poll each active one;
 *  2. diff matched-comment counts against the last pass;
 *  3. write the digest to 08-auto/_retours.md (state in _retours-state.json);
 *  4. notify ONLY when something new came back: a reply is the rarest and
 *     most valuable event this system knows, it must never drown in routine.
 *
 * Read-only towards the world: it never publishes, never DMs. Sending stays
 * with Darius (mandat d'envoi gradue).
 */

const FICHIER = '08-auto/_retours.md';
const ETAT = '08-auto/_retours-state.json';

interface EtatPost {
  matched: number;
  sent: number;
  keyword?: string;
}

interface EtatRetours {
  version: 1;
  dernierePasse: string | null;
  posts: Record<string, EtatPost>;
}

export interface PasseResult {
  ok: boolean;
  postsVus: number;
  nouveaux: number;
  enAttente: number;
  raison?: string;
}

export interface RetoursDeps {
  vault: VaultManager;
  notify?: NotifyPusher | null;
  suivi?: PubliarSuivi;
  now?: () => Date;
}

export class RetoursService {
  private readonly deps: RetoursDeps;
  private readonly suivi: PubliarSuivi;

  constructor(deps: RetoursDeps) {
    this.deps = deps;
    this.suivi = deps.suivi ?? new PubliarSuivi();
  }

  private get now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async passe(): Promise<PasseResult> {
    if (!this.suivi.configured()) {
      return { ok: false, postsVus: 0, nouveaux: 0, enAttente: 0, raison: 'PUBLIAR_API_KEY absente' };
    }

    const etat = await this.lireEtat();
    const posts = await this.suivi.listPublished();
    const actifs = posts.filter(p => (p.status ?? 'active') === 'active');

    // Poll each active post; a per-post failure falls back on the list counters
    // so ONE stubborn post cannot blind the whole pass.
    const rafraichis: PostSuivi[] = [];
    for (const p of actifs) {
      const frais = await this.suivi.pollNow(p.id);
      rafraichis.push(frais && typeof frais.id === 'number' ? { ...p, ...frais } : p);
    }

    let nouveaux = 0;
    let enAttente = 0;
    const nouveauxDetails: string[] = [];
    const posterieur: Record<string, EtatPost> = {};
    for (const p of rafraichis) {
      const matched = p.matched_comments_count ?? 0;
      const sent = p.dm_sent_count ?? 0;
      const avant = etat.posts[String(p.id)];
      const delta = Math.max(0, matched - (avant?.matched ?? 0));
      nouveaux += delta;
      enAttente += Math.max(0, matched - sent);
      if (delta > 0) {
        nouveauxDetails.push(
          `${delta} × « ${p.cta_keyword ?? '?'} » sur ${extrait(p.post_excerpt)} (id ${p.id})`,
        );
      }
      posterieur[String(p.id)] = { matched, sent, keyword: p.cta_keyword };
    }

    await this.ecrireDigest(rafraichis, nouveauxDetails);
    await this.ecrireEtat({ version: 1, dernierePasse: this.now.toISOString(), posts: posterieur });

    if (nouveaux > 0 && this.deps.notify) {
      await this.deps.notify.push({
        title: `🌍 ${nouveaux} nouveau(x) retour(s) du monde`,
        message:
          `${nouveauxDetails.join('\n')}\n\n` +
          `${enAttente} commentaire(s) à mot-clé attendent un DM. Détail : 08-auto/_retours.md`,
        priority: 4,
        tags: ['earth_americas'],
      });
    }

    logger.info('retours: passe terminee', { postsVus: rafraichis.length, nouveaux, enAttente });
    return { ok: true, postsVus: rafraichis.length, nouveaux, enAttente };
  }

  /** Pending engagements from the last pass, for the morning brief line. */
  async enAttente(): Promise<number> {
    const etat = await this.lireEtat();
    return Object.values(etat.posts).reduce(
      (n, p) => n + Math.max(0, p.matched - p.sent),
      0,
    );
  }

  private async ecrireDigest(posts: PostSuivi[], nouveaux: string[]): Promise<void> {
    const jour = this.now.toISOString().slice(0, 10);
    const parArchetype = new Map<string, { posts: number; matched: number }>();
    for (const p of posts) {
      const a = p.archetype || 'inconnu';
      const cur = parArchetype.get(a) ?? { posts: 0, matched: 0 };
      cur.posts += 1;
      cur.matched += p.matched_comments_count ?? 0;
      parArchetype.set(a, cur);
    }

    const lignes = [
      '---',
      'type: systeme',
      'tags: [retours, publiar, engagement]',
      `updated: ${jour}`,
      '---',
      '',
      '# Retours du monde : ce que les posts ont rapporté',
      '',
      `Dernière passe : ${this.now.toISOString()}. Écrit par le serveur ; ne pas éditer.`,
      'Un commentaire qui porte le mot-clé CTA est un engagement : quelqu’un a demandé la ressource promise.',
      '',
      ...(nouveaux.length > 0
        ? ['## Nouveau depuis la dernière passe', '', ...nouveaux.map(n => `- ${n}`), '']
        : []),
      '## Par post',
      '',
      '| Post | Mot-clé | Engagements | DM envoyés | En attente |',
      '|---|---|---|---|---|',
      ...posts.map(p => {
        const m = p.matched_comments_count ?? 0;
        const s = p.dm_sent_count ?? 0;
        return `| ${extrait(p.post_excerpt)} (id ${p.id}) | ${p.cta_keyword ?? ''} | ${m} | ${s} | ${Math.max(0, m - s)} |`;
      }),
      '',
      '## Par archétype',
      '',
      '| Archétype | Posts | Engagements |',
      '|---|---|---|',
      ...[...parArchetype.entries()]
        .sort((a, b) => b[1].matched - a[1].matched)
        .map(([a, v]) => `| ${a} | ${v.posts} | ${v.matched} |`),
      '',
    ];
    await this.deps.vault.writeFile(FICHIER, lignes.join('\n'));
  }

  private async lireEtat(): Promise<EtatRetours> {
    try {
      const brut = JSON.parse(await this.deps.vault.readFile(ETAT)) as Partial<EtatRetours>;
      return {
        version: 1,
        dernierePasse: typeof brut.dernierePasse === 'string' ? brut.dernierePasse : null,
        posts: brut.posts && typeof brut.posts === 'object' ? (brut.posts as EtatRetours['posts']) : {},
      };
    } catch {
      return { version: 1, dernierePasse: null, posts: {} };
    }
  }

  private async ecrireEtat(etat: EtatRetours): Promise<void> {
    await writeStateFile(this.deps.vault, ETAT, JSON.stringify(etat, null, 1));
  }
}

function extrait(texte: string | undefined): string {
  const t = (texte ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || '(sans extrait)';
}
