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
