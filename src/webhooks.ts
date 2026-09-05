// Outbound Webhook subsystem: maps Soloist state events to operator URLs, delivers
// best-effort through a throttled drop-oldest queue, and records a global delivery
// history ring buffer.

import type { Config, WebhooksConfig } from "./config.js";
import type { SoloistHub } from "./hub.js";
import { makeLog } from "./log.js";
import type { WebhookDelivery } from "./wire-contract.js";

const log = makeLog("webhooks");

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
        log.error("webhook task threw: %s", (err as Error).message);
      }
      const delay = this.getDelay();
      if (delay > 0) {
        this.schedule(() => this.drain(), delay);
        return;
      }
    }
  }
}

export const WEBHOOK_HISTORY_CAP = 10;
export const WEBHOOK_RESP_BODY_CAP = 8192;

export const WEBHOOK_RESP_HEADER_ALLOWLIST = new Set([
  "content-type", "content-length", "date", "server", "content-encoding", "etag", "cache-control", "age", "vary",
]);

export type { WebhookDelivery } from "./wire-contract.js";

export class WebhookHistory {
  private buf: WebhookDelivery[] = [];
  private cap: number;
  private listeners = new Set<(d: WebhookDelivery) => void>();

  constructor(cap = WEBHOOK_HISTORY_CAP) {
    this.cap = cap;
  }

  record(d: WebhookDelivery): void {
    this.buf.push(d);
    if (this.buf.length > this.cap) this.buf.shift();
    for (const cb of this.listeners) {
      try {
        cb(d);
      } catch (err) {
        log.error("webhook onEntry cb threw: %s", (err as Error).message);
      }
    }
  }

  entries(): WebhookDelivery[] {
    return [...this.buf];
  }

  last(): WebhookDelivery | null {
    return this.buf.length ? this.buf[this.buf.length - 1] : null;
  }

  onEntry(cb: (d: WebhookDelivery) => void): () => void {
    this.listeners.add(cb);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.listeners.delete(cb);
    };
  }
}

// Reads res.body incrementally so a huge/slow response can't be buffered in full —
// stops once WEBHOOK_RESP_BODY_CAP bytes have been accumulated.
async function readCappedBody(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        total += value.length;
        // Read one byte past the cap so a body sized exactly to the cap is not
        // mistaken for a truncated one.
        if (total > cap) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks);
  let body = buf.subarray(0, cap).toString("utf8");
  if (buf.length > cap) body += "…[truncated]";
  return body;
}

export async function postWebhook(
  history: WebhookHistory,
  type: string,
  url: string,
  body: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const reqHeaders: Record<string, string> = { "content-type": "application/json" };
  if (secret) reqHeaders.authorization = `Bearer ${secret}`;
  const at = Date.now();
  let status: number | null = null;
  let respHeaders: Record<string, string> = {};
  let respBody = "";
  let error: string | null = null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: reqHeaders,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = res.status;
    res.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (WEBHOOK_RESP_HEADER_ALLOWLIST.has(lk)) respHeaders[lk] = v;
    });
    respBody = await readCappedBody(res, WEBHOOK_RESP_BODY_CAP);
    if (!res.ok) log.warn("webhook %s -> HTTP %d", url, res.status);
  } catch (err) {
    error = (err as Error).message;
    log.error("webhook %s failed: %s", url, error);
  }
  const durationMs = Date.now() - at;
  const redactedReqHeaders = { ...reqHeaders };
  for (const k of Object.keys(redactedReqHeaders)) {
    if (k.toLowerCase() === "authorization") redactedReqHeaders[k] = "Bearer ***";
  }
  history.record({ at, type, url, status, durationMs, reqHeaders: redactedReqHeaders, respHeaders, respBody, error });
}

// Reads cfg.webhooks live (urls, secret, delay) so PUT /api/config edits apply
// without a restart.
export function attachWebhooks(hub: SoloistHub, cfg: Config): WebhookHistory {
  const history = new WebhookHistory();
  const queue = new WebhookQueue(() => cfg.webhooks.delayMs, {
    onDrop: () => log.warn("webhook queue full (%d); dropped oldest", WEBHOOK_QUEUE_CAP),
  });
  hub.observe((frame) => {
    const url = resolveWebhookUrl(frame.type, cfg.webhooks);
    if (url) queue.push(() => void postWebhook(history, frame.type, url, frame.raw, cfg.webhooks.secret));
  });
  return history;
}
