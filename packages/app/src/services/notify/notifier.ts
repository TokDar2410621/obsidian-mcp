import { logger } from '@/utils/logger';

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

export class NtfyNotifier implements NotifyPusher {
  constructor(
    private readonly url: string,
    private readonly topic: string,
    private readonly token: string | null,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

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
    } catch (error) {
      logger.warn('ntfy push failed', { error: String(error) });
    }
  }
}

/** Build the notifier from env. Null (disabled) unless NTFY_TOPIC is set. */
export function createNotifier(): NtfyNotifier | null {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return null;
  const url = process.env.NTFY_URL || 'https://ntfy.sh';
  return new NtfyNotifier(url, topic, process.env.NTFY_TOKEN || null);
}
