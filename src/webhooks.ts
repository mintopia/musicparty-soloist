// Outbound Webhook subsystem: maps Soloist state events to operator URLs, delivers
// best-effort through a throttled drop-oldest queue, and records delivery stats.

import type { Config, WebhooksConfig } from "./config.js";
import type { SoloistHub } from "./proxy.js";
import { makeLog } from "./log.js";

const log = makeLog("proxy");

export const STATE_EVENTS = new Set([
  "auth_state", "playback_state", "track_changed", "playback_changed", "volume_changed",
  "device_changed", "context_changed", "options_changed", "position_sync", "queue_changed",
]);

export function resolveWebhookUrl(type: string, cfg: WebhooksConfig): string | null {
  const override = cfg.urls[type];
  if (override) return override;
  if (STATE_EVENTS.has(type) && cfg.defaultUrl) return cfg.defaultUrl;
  return null;
}

export const WEBHOOK_QUEUE_CAP = 1000;
const WEBHOOK_TIMEOUT_MS = 5000;

export class WebhookQueue {
  private queue: (() => void)[] = [];
  private draining = false;
  private schedule: (fn: () => void, ms: number) => void;
  private cap: number;
  private onDrop: () => void;

  private getDelay: () => number;

  constructor(
    delay: number | (() => number),
    opts: { schedule?: (fn: () => void, ms: number) => void; cap?: number; onDrop?: () => void } = {},
  ) {
    this.getDelay = typeof delay === "function" ? delay : () => delay;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
    this.cap = opts.cap ?? WEBHOOK_QUEUE_CAP;
    this.onDrop = opts.onDrop ?? (() => {});
  }

  size(): number {
    return this.queue.length;
  }

  push(task: () => void): void {
    if (this.queue.length >= this.cap) {
      this.queue.shift();
      this.onDrop();
    }
    this.queue.push(task);
    if (!this.draining) this.drain();
  }

  private drain(): void {
    for (;;) {
      const task = this.queue.shift();
      if (!task) {
        this.draining = false;
        return;
      }
      this.draining = true;
      try {
        task();
      } catch (err) {
        // A throwing task must not wedge the queue with draining stuck true.
        log("webhook task threw: %s", (err as Error).message);
      }
      const delay = this.getDelay();
      if (delay > 0) {
        this.schedule(() => this.drain(), delay);
        return;
      }
    }
  }
}

export interface WebhookStat {
  lastStatus: number | null;
  lastAt: number | null;
  ok: number;
  fail: number;
  lastError: string | null;
}
export type WebhookStats = Map<string, WebhookStat>;

async function postWebhook(url: string, body: string, secret: string): Promise<{ status: number | null; error: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
    if (!res.ok) log("webhook %s -> HTTP %d", url, res.status);
    return { status: res.status, error: null };
  } catch (err) {
    log("webhook %s failed: %s", url, (err as Error).message);
    return { status: null, error: (err as Error).message };
  }
}

export function recordWebhookStat(stats: WebhookStats, url: string, status: number | null, error: string | null): void {
  const s = stats.get(url) ?? { lastStatus: null, lastAt: null, ok: 0, fail: 0, lastError: null };
  s.lastStatus = status;
  s.lastAt = Date.now();
  if (error === null && status !== null && status >= 200 && status < 300) {
    s.ok++;
  } else {
    s.fail++;
    s.lastError = error ?? `HTTP ${status}`;
  }
  stats.set(url, s);
}

// Reads cfg.webhooks live (urls, secret, delay) so PUT /api/config edits apply
// without a restart.
export function attachWebhooks(hub: SoloistHub, cfg: Config): WebhookStats {
  const stats: WebhookStats = new Map();
  const queue = new WebhookQueue(() => cfg.webhooks.delayMs, {
    onDrop: () => log("webhook queue full (%d); dropped oldest", WEBHOOK_QUEUE_CAP),
  });
  hub.observe((frame) => {
    const url = resolveWebhookUrl(frame.type, cfg.webhooks);
    if (url) queue.push(() => void postWebhook(url, frame.raw, cfg.webhooks.secret).then((r) => recordWebhookStat(stats, url, r.status, r.error)));
  });
  return stats;
}
