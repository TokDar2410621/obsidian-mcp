import { describe, it, expect, beforeAll } from 'vitest';
import { NtfyNotifier, createNotifier, createNotificationJournal } from '@/services/notify/notifier';
import type { VaultManager } from '@/services/vault-manager';
import { configureLogger } from '@/utils/logger';

beforeAll(() => {
  configureLogger({ stream: process.stdout, minLevel: 'error' });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(sent: Sent[], ok = true) {
  return async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok, status: ok ? 200 : 500 };
  };
}

describe('NtfyNotifier', () => {
  it('publishes JSON with topic, title, message, priority and tags', async () => {
    const sent: Sent[] = [];
    const notifier = new NtfyNotifier('https://ntfy.sh', 'topic-secret', null, fakeFetch(sent));

    await notifier.push({
      title: 'Cerveau — objectifs',
      message: '1 échéance.\nDétail : 08-auto',
      priority: 4,
      tags: ['brain'],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://ntfy.sh');
    expect(sent[0].body.topic).toBe('topic-secret');
    expect(sent[0].body.title).toContain('objectifs');
    expect(sent[0].body.priority).toBe(4);
    expect(sent[0].body.tags).toEqual(['brain']);
    expect(sent[0].headers.authorization).toBeUndefined();
  });

  it('transmet le click (tap du corps = Revue, fiable sur iOS)', async () => {
    const sent: Sent[] = [];
    const notifier = new NtfyNotifier('https://ntfy.sh', 't', null, fakeFetch(sent));

    await notifier.push({ title: 'x', message: 'y', click: 'https://cerveau.example/revue?k=tok' });
    await notifier.push({ title: 'sans-click', message: 'z' });

    expect(sent[0].body.click).toBe('https://cerveau.example/revue?k=tok');
    expect(sent[1].body.click).toBeUndefined();
  });

  it('sends a Bearer token when configured', async () => {
    const sent: Sent[] = [];
    const notifier = new NtfyNotifier('https://ntfy.example.com', 't', 'tok123', fakeFetch(sent));

    await notifier.push({ title: 'x', message: 'y' });

    expect(sent[0].headers.authorization).toBe('Bearer tok123');
    expect(sent[0].body.priority).toBe(3); // default
  });

  it('never throws on transport failure', async () => {
    const boom = async () => {
      throw new Error('network down');
    };
    const notifier = new NtfyNotifier('https://ntfy.sh', 't', null, boom as any);

    await expect(notifier.push({ title: 'x', message: 'y' })).resolves.toBeUndefined();
  });

  it('journalise chaque push dans 08-auto/_notifications.md (la mémoire des notifs)', async () => {
    const files = new Map<string, string>();
    const vault = {
      readFile: async (p: string) => {
        const c = files.get(p);
        if (c === undefined) throw new Error('ENOENT');
        return c;
      },
      writeFile: async (p: string, c: string) => void files.set(p, c),
    } as unknown as VaultManager;
    const notifier = new NtfyNotifier('https://ntfy.sh', 't', null, fakeFetch([]));
    notifier.setJournal(createNotificationJournal(vault));

    await notifier.push({ title: 'Brief du matin', message: 'Priorité n°1 : AR-mesure' });
    await notifier.push({ title: 'Rappel', message: 'Appeler mes soeurs' });

    const journal = files.get('08-auto/_notifications.md')!;
    const today = new Date().toISOString().slice(0, 10);
    expect(journal).toContain(`## ${today}`);
    expect(journal).toContain('**Brief du matin**');
    expect(journal).toContain('**Rappel**');
    // Le plus récent d'abord dans la section du jour.
    expect(journal.indexOf('Rappel')).toBeLessThan(journal.indexOf('Brief du matin'));
    // Une seule section pour le jour.
    expect(journal.split(`## ${today}`)).toHaveLength(2);
  });

  it('journalise aussi les échecs de transport (ÉCHEC ntfy)', async () => {
    const files = new Map<string, string>();
    const vault = {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async (p: string, c: string) => void files.set(p, c),
    } as unknown as VaultManager;
    const boom = async () => {
      throw new Error('network down');
    };
    const notifier = new NtfyNotifier('https://ntfy.sh', 't', null, boom as any);
    notifier.setJournal(createNotificationJournal(vault));

    await notifier.push({ title: 'x', message: 'y' });

    expect(files.get('08-auto/_notifications.md')).toContain('ÉCHEC ntfy');
  });

  it('createNotifier is disabled without NTFY_TOPIC', () => {
    delete process.env.NTFY_TOPIC;
    expect(createNotifier()).toBeNull();
  });

  it('createNotifier enables with NTFY_TOPIC', () => {
    process.env.NTFY_TOPIC = 'abc';
    expect(createNotifier()).not.toBeNull();
    delete process.env.NTFY_TOPIC;
  });
});

// --- la piece jointe : la notification porte le FICHIER, pas son chemin -------

describe('NtfyNotifier : la pièce jointe', () => {
  it('44. attach, filename et icon ne partent que quand ils sont définis', async () => {
    const sent: Sent[] = [];
    const notifier = new NtfyNotifier('https://ntfy.sh', 't', null, fakeFetch(sent));

    await notifier.push({
      title: 'Terminé',
      message: 'Le hero est prêt.',
      attach: 'https://cerveau.example/livrable?f=hero.png&e=9&s=sig',
      filename: 'hero.png',
      icon: 'https://cerveau.example/livrable?f=icone.png&e=9&s=sig',
    });
    await notifier.push({ title: 'sans-piece', message: 'rien' });

    expect(sent[0].body.attach).toContain('/livrable?f=hero.png');
    expect(sent[0].body.filename).toBe('hero.png');
    expect(sent[0].body.icon).toContain('/livrable?f=icone.png');
    expect(sent[1].body.attach).toBeUndefined();
    expect(sent[1].body.filename).toBeUndefined();
    expect(sent[1].body.icon).toBeUndefined();
  });

  it('45. le journal du coffre NOMME le fichier livré', async () => {
    // Sinon déplacer le livrable dans `attach` effacerait sa seule trace :
    // ntfy ne garde que ~12 h, ce fichier-là est la mémoire.
    const files = new Map<string, string>();
    const vault = {
      readFile: async (p: string) => {
        const c = files.get(p);
        if (c === undefined) throw new Error('ENOENT');
        return c;
      },
      writeFile: async (p: string, c: string) => void files.set(p, c),
    } as unknown as VaultManager;
    const sent: Sent[] = [];
    const notifier = new NtfyNotifier('https://ntfy.sh', 't', null, fakeFetch(sent));
    notifier.setJournal(createNotificationJournal(vault));

    await notifier.push({
      title: 'Terminé : affiche LinkedIn',
      message: 'Refaite en Pillow, 2 bugs corrigés.',
      attach: 'https://cerveau.example/livrable?f=affiche.png&e=9&s=sig',
      filename: 'affiche-linkedin.png',
    });

    const journal = files.get('08-auto/_notifications.md') ?? '';
    expect(journal).toContain('affiche-linkedin.png');
    expect(journal).toContain('📎');
  });
});
