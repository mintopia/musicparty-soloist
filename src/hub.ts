// Kept free of HTTP wiring so relay.ts/webhooks.ts can depend on it without cycling
// through the proxy composition root.

import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, type RawData } from "ws";
import type { ClientMeta } from "./wire-contract.js";
import { STATE_EVENTS } from "./webhooks.js";
import { deferred } from "./util.js";
import { reconnectLoop } from "./reconnect.js";
import { makeLog } from "./log.js";

const log = makeLog("proxy");

const HUB_BACKOFF_BASE = 0.5;
const HUB_BACKOFF_MAX = 30.0;
const HUB_READY_TIMEOUT = 5.0;

// Downstream backpressure (mirrors appcontrol): a stalled/half-open client makes ws buffer
// high-rate upstream frames unbounded → heap growth. Drop frames for a client past the soft
// cap, close it past the hard cap; on reconnect the latestState replay in register() catches
// it back up.
const HUB_BUFFER_DROP_BYTES = 1024 * 1024;
const HUB_BUFFER_CLOSE_BYTES = 8 * 1024 * 1024;

export interface UpstreamFrame {
  type: string;
  message: Record<string, unknown>;
  raw: string;
}

export type { ClientMeta };

export type FrameObserver = (frame: UpstreamFrame) => void;

export function decodeFrame(data: RawData, isBinary: boolean): UpstreamFrame | null {
  if (isBinary) return null;
  const raw = data.toString();
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const type = (message as Record<string, unknown>).type;
  if (typeof type !== "string") return null;
  return { type, message: message as Record<string, unknown>, raw };
}

export class SoloistHub {
  // Resolved live on each (re)connect so a soloist_ws change applies after a
  // Soloist restart without restarting the Proxy.
  private urlFn: () => string;
  private clients = new Map<WebSocket, ClientMeta>();
  private latestState = new Map<string, UpstreamFrame>();
  private observers = new Set<FrameObserver>();
  private connectFn: (() => void) | null = null;
  private conn: WebSocket | null = null;
  private ready: { promise: Promise<void>; resolve: () => void };
  private wake = deferred();
  private stopped = false;

  constructor(url: string | (() => string)) {
    this.urlFn = typeof url === "function" ? url : () => url;
    this.ready = deferred();
  }

  get url(): string {
    return this.urlFn();
  }

  observe(fn: FrameObserver): void {
    this.observers.add(fn);
  }

  onConnect(fn: () => void): void {
    this.connectFn = fn;
  }

  inject(message: Record<string, unknown>): void {
    const conn = this.conn;
    if (conn && conn.readyState === WebSocket.OPEN) conn.send(JSON.stringify(message));
  }

  // Raw bytes straight to the upstream Soloist socket (the Relay's inbound path —
  // transparent passthrough, no decode). Dropped if upstream isn't OPEN.
  sendUpstream(data: RawData, isBinary: boolean): void {
    const conn = this.conn;
    if (conn && conn.readyState === WebSocket.OPEN) conn.send(data, { binary: isBinary });
  }

  // Push a proxy-originated message (not from upstream) to every connected client —
  // e.g. live overlay-config updates so open overlays restyle on save.
  broadcastMessage(obj: Record<string, unknown>): void {
    const raw = JSON.stringify(obj);
    for (const client of this.clients.keys()) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }

  register(client: WebSocket, meta: ClientMeta): void {
    this.clients.set(client, meta);
    for (const frame of this.latestState.values()) {
      if (client.readyState === WebSocket.OPEN) client.send(frame.raw);
    }
  }

  unregister(client: WebSocket): void {
    this.clients.delete(client);
  }

  async forward(client: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    if (this.clients.get(client)?.tier === "readonly") return;
    const ac = new AbortController();
    const timeout = sleep(HUB_READY_TIMEOUT * 1000, "timeout" as const, { signal: ac.signal }).catch(
      () => "aborted" as const,
    );
    const winner = await Promise.race([this.ready.promise.then(() => "ready" as const), timeout]);
    ac.abort();
    if (winner !== "ready") return;
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    conn.send(data, { binary: isBinary });
  }

  private onUpstream(data: RawData, isBinary: boolean): void {
    const frame = decodeFrame(data, isBinary);
    if (frame) {
      if (STATE_EVENTS.has(frame.type)) this.latestState.set(frame.type, frame);
      for (const obs of this.observers) {
        try {
          obs(frame);
        } catch (err) {
          log.error("frame observer error: %s", (err as Error).message);
        }
      }
    }
    this.broadcast(data, isBinary);
  }

  private broadcast(data: RawData, isBinary: boolean): void {
    // Skip rather than delete: the proxy's onGone handler already calls unregister() on
    // socket close/error, so this map is cleaned up there — pruning here too would race it.
    for (const client of this.clients.keys()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const buffered = client.bufferedAmount;
      if (buffered > HUB_BUFFER_CLOSE_BYTES) {
        log.warn("closing slow downstream client: %d bytes buffered", buffered);
        client.close(1013, "slow consumer");
        continue;
      }
      if (buffered > HUB_BUFFER_DROP_BYTES) continue;
      client.send(data, { binary: isBinary });
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  clientList(): ClientMeta[] {
    return [...this.clients.values()];
  }

  get upstreamConnected(): boolean {
    return this.conn?.readyState === WebSocket.OPEN;
  }

  // null while upstream is down (state is stale); otherwise the last auth_state.logged_in.
  // latestState is intentionally NOT cleared on disconnect (its replay role is preserved).
  loggedIn(): boolean | null {
    if (!this.upstreamConnected) return null;
    return this.latestState.get("auth_state")?.message.logged_in === true;
  }

  private signalWake(): void {
    this.wake.resolve();
    this.wake = deferred();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
    this.signalWake();
    // Drop every observer so the diagnostic and Relay subscriptions attached over this Hub's
    // lifetime don't outlive it (nothing re-arms them after stop).
    this.observers.clear();
  }

  async run(): Promise<void> {
    // Resolved fresh in connect() (not hoisted) so a mid-loop soloist_ws change is picked
    // up on the very next dial.
    let currentUrl = "";
    await reconnectLoop({
      backoffBase: HUB_BACKOFF_BASE,
      backoffMax: HUB_BACKOFF_MAX,
      isStopped: () => this.stopped,
      getWake: () => this.wake,
      shouldDial: () => true,
      connect: () => {
        currentUrl = this.urlFn();
        return new WebSocket(currentUrl);
      },
      onOpen: (conn) => {
        log("connected to soloist upstream %s", currentUrl);
        this.conn = conn;
        this.ready.resolve();
        try {
          this.connectFn?.();
        } catch (err) {
          log.error("connect observer error: %s", (err as Error).message);
        }
      },
      onMessage: (data, isBinary) => this.onUpstream(data, isBinary),
      onError: (err) => log.error("soloist upstream %s error: %s", currentUrl, err.message),
      onSettled: () => {
        this.conn = null;
        this.ready = deferred();
      },
      onReconnectWait: (backoff) => log.warn("soloist upstream down; reconnecting in %ss", backoff),
    });
  }
}
