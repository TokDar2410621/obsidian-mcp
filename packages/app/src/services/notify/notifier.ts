import { logger } from '@/utils/logger';
import type { VaultManager } from '@/services/vault-manager';

/**
 * Push notifications to Darius's phone via ntfy (https://ntfy.sh) — the
 * cerveau's "reach the human" channel. Dumb and deterministic on purpose:
 * one HTTPS POST, no bridge, no LLM. Enabled only when NTFY_TOPIC is set
 * (the topic name acts as the secret — pick an unguessable one).
 *
 *   NTFY_TOPIC  required to enable (e.g. cerveau-x7k2m9...)
 *   NTFY_URL    optional server (default https://ntfy.sh)
 *   NTFY_TOKEN  optional Bearer token (self-hosted / protected topics)
 */

export interface NotificationAction {
  /** Button label shown on the phone (keep it short). */
  label: string;
  /** URL opened (GET) when tapped — e.g. a token-gated answer endpoint. */
  url: string;
}

export interface Notification {
  title: string;
  message: string;
  /** ntfy priority 1 (min) .. 5 (urgent). Default 3. */
  priority?: number;
  /** ntfy tags — emoji shortcodes ('brain', 'dart') or plain labels. */
  tags?: string[];
  /** Up to 3 tap-to-answer buttons (ntfy 'view' actions). */
  actions?: NotificationAction[];
}

export interface NotifyPusher {
  push(notification: Notification): Promise<void>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/** Durable trace of a push (what the phone was told, and whether it left). */
export type NotificationJournal = (notification: Notification, ok: boolean) => Promise<void>;

export class NtfyNotifier implements NotifyPusher {
  private journal: NotificationJournal | null = null;

  constructor(
    private readonly url: string,
    private readonly topic: string,
    private readonly token: string | null,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Wire the durable journal (vault). ntfy keeps ~12h of cache: without this,
   *  "what did you push to me?" is unanswerable (audit of 2026-07-10). */
  setJournal(journal: NotificationJournal): void {
    this.journal = journal;
  }

  /** Fire-and-forget. Never throws — an unreachable phone must not break a sweep. */
  async push(notification: Notification): Promise<void> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      // JSON publish mode: UTF-8 titles/messages survive (plain ntfy headers do not).
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          topic: this.topic,
          title: notification.title,
          message: notification.message,
          priority: notification.priority ?? 3,
          tags: notification.tags ?? [],
          ...(notification.actions && notification.actions.length > 0
            ? {
                actions: notification.actions.slice(0, 3).map(a => ({
                  action: 'view',
                  label: a.label,
                  url: a.url,
                  clear: true,
                })),
              }
            : {}),
        }),
      });
      if (!res.ok) logger.warn('ntfy push failed', { status: res.status });
      await this.journal?.(notification, res.ok);
    } catch (error) {
      logger.warn('ntfy push failed', { error: String(error) });
      await this.journal?.(notification, false).catch(() => undefined);
    }
  }
}

/** Vault journal of every push: `08-auto/_notifications.md`, one dated line
 *  per notification, newest day first, capped. This is the memory of what the
 *  cerveau told Darius — the phone's ntfy cache lasts ~12h, this lasts. */
const JOURNAL_FILE = '08-auto/_notifications.md';
const JOURNAL_MAX_DAYS = 30;

export function createNotificationJournal(vault: VaultManager): NotificationJournal {
  return async (notification, ok) => {
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const hm = now.toISOString().slice(11, 16);
      const msg = notification.message.replace(/\s+/g, ' ').trim();
      const line = `- ${hm} · **${notification.title}** · ${msg.length > 160 ? `${msg.slice(0, 157)}...` : msg}${ok ? '' : ' · ÉCHEC ntfy'}`;
      const header = [
        '---', 'type: note', 'tags: [auto, notifications]', '---', '',
        '# Journal des notifications (auto)', '',
        "> Tout ce que le cerveau a poussé sur le téléphone, heure UTC, jour par jour.",
        "> C'est la mémoire des notifs : ntfy n'en garde que ~12 h.", '',
      ].join('\n');
      let body = '';
      try {
        const existing = await vault.readFile(JOURNAL_FILE);
        const idx = existing.indexOf('\n## ');
        body = idx >= 0 ? existing.slice(idx) : '';
      } catch {
        /* first notification ever */
      }
      const todayHeader = `\n## ${day}\n`;
      if (body.startsWith(todayHeader)) {
        body = `${todayHeader}\n${line}\n${body.slice(todayHeader.length).replace(/^\n/, '')}`;
      } else {
        body = `${todayHeader}\n${line}\n${body}`;
      }
      const sections = body.split(/\n(?=## )/).slice(0, JOURNAL_MAX_DAYS);
      await vault.writeFile(JOURNAL_FILE, header + sections.join('\n'));
    } catch (error) {
      logger.warn('notification journal write failed', { error: String(error) });
    }
  };
}

/** Build the notifier from env. Null (disabled) unless NTFY_TOPIC is set. */
export function createNotifier(): NtfyNotifier | null {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return null;
  const url = process.env.NTFY_URL || 'https://ntfy.sh';
  return new NtfyNotifier(url, topic, process.env.NTFY_TOKEN || null);
}
