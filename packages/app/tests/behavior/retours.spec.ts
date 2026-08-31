import { describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';

configureLogger({ stream: process.stderr, minLevel: 'error' });
import { InMemoryVaultManager } from '@tests/support/doubles/in-memory-vault-manager.js';
import { RetoursService } from '@/services/retours/retours';
import { PubliarSuivi, type PostSuivi } from '@/services/retours/publiar-suivi';
import type { Notification, NotifyPusher } from '@/services/notify/notifier';

/**
 * Retours du monde : la passe quotidienne qui lit ce que les posts ont
 * rapporté. Un retour est rare et précieux : il notifie ; une passe sans rien
 * de neuf se tait ; un poll qui refuse retombe sur les compteurs du listing.
 */

class NotifierEspion implements NotifyPusher {
  pushed: Notification[] = [];
  async push(n: Notification): Promise<void> {
    this.pushed.push(n);
  }
}

class SuiviFake extends PubliarSuivi {
  posts: PostSuivi[] = [];
  polls: Record<number, PostSuivi | null> = {};
  pollAppels: number[] = [];
  constructor() {
    super();
  }
  override configured(): boolean {
    return true;
  }
  override async listPublished(): Promise<PostSuivi[]> {
    return this.posts;
  }
  override async pollNow(id: number): Promise<PostSuivi | null> {
    this.pollAppels.push(id);
    return this.polls[id] ?? null;
  }
}

function fabrique(posts: PostSuivi[], polls: Record<number, PostSuivi | null> = {}) {
  const vault = new InMemoryVaultManager({});
  const notify = new NotifierEspion();
  const suivi = new SuiviFake();
  suivi.posts = posts;
  suivi.polls = polls;
  const service = new RetoursService({
    vault,
    notify,
    suivi,
    now: () => new Date('2026-08-31T11:00:00Z'),
  });
  return { vault, notify, suivi, service };
}

const POST = (sur: Partial<PostSuivi>): PostSuivi => ({
  id: 1,
  post_urn: 'urn:li:share:1',
  cta_keyword: 'BANC04',
  archetype: 'clay_render',
  status: 'active',
  matched_comments_count: 0,
  dm_sent_count: 0,
  post_excerpt: "J'ai mesuré Crawl4AI sur 7 sites",
  ...sur,
});

describe('Retours : la passe', () => {
  it('sans cle API : refuse proprement, raison explicite', async () => {
    const vault = new InMemoryVaultManager({});
    const service = new RetoursService({ vault, suivi: new PubliarSuivi() });
    const r = await service.passe();
    expect(r.ok).toBe(false);
    expect(r.raison).toContain('PUBLIAR_API_KEY');
  });

  it('sonde chaque post actif, ignore les inactifs', async () => {
    const { suivi, service } = fabrique([
      POST({ id: 1 }),
      POST({ id: 2, status: 'archived' }),
      POST({ id: 3 }),
    ]);
    const r = await service.passe();
    expect(r.ok).toBe(true);
    expect(suivi.pollAppels).toEqual([1, 3]);
    expect(r.postsVus).toBe(2);
  });

  it('un nouveau commentaire a mot-cle : notifie, priorite 4, mot-cle cite', async () => {
    const { notify, service } = fabrique([POST({ id: 1 })], {
      1: POST({ id: 1, matched_comments_count: 2 }),
    });
    const r = await service.passe();
    expect(r.nouveaux).toBe(2);
    expect(r.enAttente).toBe(2);
    expect(notify.pushed).toHaveLength(1);
    expect(notify.pushed[0].priority).toBe(4);
    expect(notify.pushed[0].message).toContain('BANC04');
  });

  it('rien de neuf : la passe se TAIT, le digest est quand meme ecrit', async () => {
    const { vault, notify, service } = fabrique([POST({ id: 1 })]);
    await service.passe();
    expect(notify.pushed).toHaveLength(0);
    const digest = await vault.readFile('08-auto/_retours.md');
    expect(digest).toContain('BANC04');
    expect(digest).toContain('clay_render');
  });

  it('deja vu a la passe precedente : pas re-notifie', async () => {
    const { notify, service } = fabrique([POST({ id: 1 })], {
      1: POST({ id: 1, matched_comments_count: 1 }),
    });
    await service.passe();
    expect(notify.pushed).toHaveLength(1);
    await service.passe();
    expect(notify.pushed).toHaveLength(1); // le meme commentaire ne compte qu'une fois
  });

  it('poll refuse sur UN post : ses compteurs du listing servent, la passe survit', async () => {
    const { notify, service } = fabrique(
      [POST({ id: 1, matched_comments_count: 3 }), POST({ id: 2 })],
      { 2: POST({ id: 2, matched_comments_count: 1 }) }, // le poll de 1 rend null
    );
    const r = await service.passe();
    expect(r.ok).toBe(true);
    expect(r.nouveaux).toBe(4); // 3 du listing + 1 du poll
    expect(notify.pushed).toHaveLength(1);
  });

  it('enAttente distingue matched et DM deja envoyes', async () => {
    const { service } = fabrique([POST({ id: 1 })], {
      1: POST({ id: 1, matched_comments_count: 5, dm_sent_count: 3 }),
    });
    await service.passe();
    expect(await service.enAttente()).toBe(2);
  });
});
