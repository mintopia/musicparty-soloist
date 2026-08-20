// Fronts Soloist's unauthenticated localhost-only control WS with token auth (ADR-0001).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Config, WebhooksConfig } from "./config.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`${new Date().toISOString()} soloist.proxy ${msg}`, ...args);

const BEARER = "Bearer ";

const HUB_BACKOFF_BASE = 0.5;
const HUB_BACKOFF_MAX = 30.0;
const HUB_READY_TIMEOUT = 5.0;

export function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith(BEARER)) return auth.slice(BEARER.length);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

export function checkAuth(req: IncomingMessage, token: string): boolean {
  const presented = presentedToken(req);
  if (presented === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UpstreamFrame {
  type: string;
  message: Record<string, unknown>;
  raw: string;
}

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

export interface AutoplayState {
  fired: boolean;
}

export function shouldAutoplay(prev: AutoplayState, next: UpstreamFrame): boolean {
  return !prev.fired && next.type === "auth_state" && next.message.logged_in === true;
}

export class SoloistHub {
  readonly url: string;
  private clients = new Set<WebSocket>();
  private observers = new Set<FrameObserver>();
  private connectFn: (() => void) | null = null;
  private conn: WebSocket | null = null;
  private ready: { promise: Promise<void>; resolve: () => void };
  private stopped = false;

  constructor(url: string) {
    this.url = url;
    this.ready = deferred();
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

  register(client: WebSocket): void {
    this.clients.add(client);
  }

  unregister(client: WebSocket): void {
    this.clients.delete(client);
  }

  async forward(data: RawData, isBinary: boolean): Promise<void> {
    const timedOut = Symbol();
    const winner = await Promise.race([this.ready.promise, sleep(HUB_READY_TIMEOUT * 1000).then(() => timedOut)]);
    if (winner === timedOut) return;
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    conn.send(data, { binary: isBinary });
  }

  private onUpstream(data: RawData, isBinary: boolean): void {
    const frame = decodeFrame(data, isBinary);
    if (frame) {
      for (const obs of this.observers) {
        try {
          obs(frame);
        } catch (err) {
          log("frame observer error: %s", (err as Error).message);
        }
      }
    }
    this.broadcast(data, isBinary);
  }

  private broadcast(data: RawData, isBinary: boolean): void {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      } else {
        this.clients.delete(client);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
  }

  async run(): Promise<void> {
    let backoff = HUB_BACKOFF_BASE;
    while (!this.stopped) {
      try {
        await new Promise<void>((resolve, reject) => {
          const conn = new WebSocket(this.url);
          conn.on("open", () => {
            log("connected to soloist upstream %s", this.url);
            this.conn = conn;
            this.ready.resolve();
            backoff = HUB_BACKOFF_BASE;
            try {
              this.connectFn?.();
            } catch (err) {
              log("connect observer error: %s", (err as Error).message);
            }
          });
          conn.on("message", (data, isBinary) => this.onUpstream(data, isBinary));
          conn.on("error", (err) => reject(err));
          conn.on("close", () => resolve());
        });
      } catch (err) {
        log("soloist upstream %s error: %s", this.url, (err as Error).message);
      } finally {
        this.conn = null;
        this.ready = deferred();
      }
      if (this.stopped) break;
      log("soloist upstream down; reconnecting in %ss", backoff);
      await sleep(backoff * 1000);
      backoff = Math.min(backoff * 2, HUB_BACKOFF_MAX);
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function listenParts(listen: string): { host: string; port: number } {
  const i = listen.lastIndexOf(":");
  const host = i > 0 ? listen.slice(0, i) : "0.0.0.0";
  const port = Number(listen.slice(i + 1));
  return { host: host || "0.0.0.0", port };
}

export interface RunningProxy {
  server: Server;
  hub: SoloistHub;
  close(): Promise<void>;
}

function attachAutoplay(hub: SoloistHub): void {
  const state: AutoplayState = { fired: false };
  hub.onConnect(() => (state.fired = false));
  hub.observe((frame) => {
    if (frame.type === "error") log("autoplay: upstream error frame: %s", frame.raw);
    if (!shouldAutoplay(state, frame)) return;
    state.fired = true;
    log("autoplay: logged in, injecting activate then play");
    hub.inject({ type: "activate" });
    hub.inject({ type: "play" });
  });
}

const STATE_EVENTS = new Set([
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

  constructor(
    private delayMs: number,
    opts: { schedule?: (fn: () => void, ms: number) => void; cap?: number; onDrop?: () => void } = {},
  ) {
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
      task();
      if (this.delayMs > 0) {
        this.schedule(() => this.drain(), this.delayMs);
        return;
      }
    }
  }
}

async function postWebhook(url: string, body: string, secret: string): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
    if (!res.ok) log("webhook %s -> HTTP %d", url, res.status);
  } catch (err) {
    log("webhook %s failed: %s", url, (err as Error).message);
  }
}

function attachWebhooks(hub: SoloistHub, wh: WebhooksConfig): void {
  const queue = new WebhookQueue(wh.delayMs, {
    onDrop: () => log("webhook queue full (%d); dropped oldest", WEBHOOK_QUEUE_CAP),
  });
  hub.observe((frame) => {
    const url = resolveWebhookUrl(frame.type, wh);
    if (url) queue.push(() => void postWebhook(url, frame.raw, wh.secret));
  });
}

export function makeServer(cfg: Config): Promise<RunningProxy> {
  const { host, port } = listenParts(cfg.proxy.listen);
  const hub = new SoloistHub(`ws://${cfg.soloistWs}`);
  if (cfg.autoplay) attachAutoplay(hub);
  const wh = cfg.webhooks;
  if (wh.defaultUrl || Object.keys(wh.urls).length > 0) attachWebhooks(hub, wh);
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer();

  server.on("upgrade", (req, socket, head) => {
    if (!checkAuth(req, cfg.proxy.token)) {
      log("rejected connection from %s: bad/missing token", req.socket.remoteAddress);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nUnauthorized\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      hub.register(client);
      client.on("message", (data, isBinary) => hub.forward(data, isBinary));
      client.on("close", () => hub.unregister(client));
      client.on("error", () => hub.unregister(client));
    });
  });

  const hubRun = hub.run();
  hubRun.catch((e) => log("hub crashed: %s", (e as Error).message));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log("proxy listening on %s -> ws://%s", cfg.proxy.listen, cfg.soloistWs);
      resolve({
        server,
        hub,
        close: () =>
          new Promise<void>((res) => {
            hub.stop();
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}

export async function serveProxy(cfg: Config, signal: AbortSignal): Promise<void> {
  const running = await makeServer(cfg);
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  await running.close();
}
