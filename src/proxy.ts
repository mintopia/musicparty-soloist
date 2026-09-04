// Fronts Soloist's unauthenticated localhost-only control WS with token auth (ADR-0001).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Config, WebhooksConfig } from "./config.js";
import type { SoloistControl } from "./supervisor.js";
import { handleWebRequest, sessionUser } from "./web.js";
import { reconcileOutputs } from "./pipewire.js";
import { makeLog } from "./log.js";

const log = makeLog("proxy");

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

function tokenEquals(presented: string, token: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AuthTier = "control" | "readonly" | "none";

// control = Auth Token or valid Web Session; readonly = Read-only Token; else none.
export function checkAuth(req: IncomingMessage, cfg: Config): AuthTier {
  const presented = presentedToken(req);
  if (presented !== null) {
    // Guard the empty token: in setup mode proxy.token is "", and an empty presented
    // token would timing-safe-equal it — never grant control on an unset token.
    if (cfg.proxy.token && tokenEquals(presented, cfg.proxy.token)) return "control";
    if (cfg.proxy.readonlyToken && tokenEquals(presented, cfg.proxy.readonlyToken)) return "readonly";
  }
  if (sessionUser(req, cfg)) return "control";
  return "none";
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
  // Resolved live on each (re)connect so a soloist_ws change applies after a
  // Soloist restart without restarting the Proxy.
  private urlFn: () => string;
  private clients = new Set<WebSocket>();
  private readonlyClients = new WeakSet<WebSocket>();
  private latestState = new Map<string, UpstreamFrame>();
  private observers = new Set<FrameObserver>();
  private connectFn: (() => void) | null = null;
  private conn: WebSocket | null = null;
  private ready: { promise: Promise<void>; resolve: () => void };
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
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }

  register(client: WebSocket, opts: { readOnly?: boolean } = {}): void {
    this.clients.add(client);
    if (opts.readOnly) this.readonlyClients.add(client);
    for (const frame of this.latestState.values()) {
      if (client.readyState === WebSocket.OPEN) client.send(frame.raw);
    }
  }

  unregister(client: WebSocket): void {
    this.clients.delete(client);
    this.readonlyClients.delete(client);
  }

  async forward(client: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    if (this.readonlyClients.has(client)) return; // read-only tier never reaches upstream
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
      const url = this.urlFn();
      try {
        await new Promise<void>((resolve, reject) => {
          const conn = new WebSocket(url);
          conn.on("open", () => {
            log("connected to soloist upstream %s", url);
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
        log("soloist upstream %s error: %s", url, (err as Error).message);
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

// Soloist commands take type "command" + a command field (not type:"activate").
export const AUTOPLAY_FRAMES: Record<string, unknown>[] = [
  { type: "command", command: "activate" },
  { type: "command", command: "play" },
];

// Reads cfg.autoplay live so a PUT /api/config toggle applies without a restart.
function attachAutoplay(hub: SoloistHub, cfg: Config): void {
  const state: AutoplayState = { fired: false };
  hub.onConnect(() => (state.fired = false));
  hub.observe((frame) => {
    if (!cfg.autoplay) return;
    if (frame.type === "error") log("autoplay: upstream error frame: %s", frame.raw);
    if (!shouldAutoplay(state, frame)) return;
    state.fired = true;
    log("autoplay: logged in, injecting activate then play");
    for (const frame of AUTOPLAY_FRAMES) hub.inject(frame);
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
      task();
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
function attachWebhooks(hub: SoloistHub, cfg: Config): WebhookStats {
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

const RELAY_BACKOFF_BASE = 0.5;
const RELAY_BACKOFF_MAX = 30.0;

export interface RelayStatus {
  enabled: boolean;         // url configured
  connected: boolean;
  lastConnectAt: number | null;
  lastError: string | null;
}

// A persistent outbound WS bridge to a single Relay Server (ADR-0012): republishes
// every Soloist→downstream frame verbatim, and forwards every received frame raw to
// the upstream Soloist socket (full control). Reconnects with backoff while a url is
// configured; re-dials live when url/authorization changes (apply()).
export class SoloistRelay {
  private conn: WebSocket | null = null;
  private stopped = false;
  private wake = deferred();
  private appliedUrl: string;
  private appliedAuth: string;
  readonly status: RelayStatus = { enabled: false, connected: false, lastConnectAt: null, lastError: null };

  constructor(hub: SoloistHub, private cfg: Config) {
    this.appliedUrl = cfg.relay.url;
    this.appliedAuth = cfg.relay.authorization;
    // Outbound: mirror what a Downstream Client observes, unfiltered, verbatim.
    hub.observe((frame) => {
      const c = this.conn;
      if (c && c.readyState === WebSocket.OPEN) c.send(frame.raw);
    });
    // Inbound: raw bytes straight upstream, transparent — the Relay Server is a
    // full-control peer.
    this.onMessage = (data, isBinary) => hub.sendUpstream(data, isBinary);
  }

  private onMessage: (data: RawData, isBinary: boolean) => void;

  private signal(): void {
    this.wake.resolve();
    this.wake = deferred();
  }

  // Re-dial only if url/authorization actually changed, so an unrelated config save
  // never needlessly drops a healthy relay connection.
  apply(): void {
    if (this.cfg.relay.url === this.appliedUrl && this.cfg.relay.authorization === this.appliedAuth) return;
    this.appliedUrl = this.cfg.relay.url;
    this.appliedAuth = this.cfg.relay.authorization;
    this.conn?.close();
    this.signal();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
    this.signal();
  }

  async run(): Promise<void> {
    let backoff = RELAY_BACKOFF_BASE;
    while (!this.stopped) {
      const url = this.cfg.relay.url;
      this.status.enabled = url !== "";
      if (!url) {
        this.status.connected = false;
        await this.wake.promise; // park until apply()/stop()
        continue;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const headers: Record<string, string> = {};
          if (this.cfg.relay.authorization) headers.authorization = this.cfg.relay.authorization;
          const conn = new WebSocket(url, { headers });
          conn.on("open", () => {
            log("relay connected to %s", url);
            this.conn = conn;
            this.status.connected = true;
            this.status.lastConnectAt = Date.now();
            this.status.lastError = null;
            backoff = RELAY_BACKOFF_BASE;
          });
          conn.on("message", (data, isBinary) => this.onMessage(data, isBinary));
          conn.on("error", (err) => reject(err));
          conn.on("close", () => resolve());
        });
      } catch (err) {
        this.status.lastError = (err as Error).message;
        log("relay %s error: %s", url, (err as Error).message);
      } finally {
        this.conn = null;
        this.status.connected = false;
      }
      if (this.stopped) break;
      // Backoff, but wake early on apply()/stop().
      await Promise.race([sleep(backoff * 1000), this.wake.promise]);
      backoff = Math.min(backoff * 2, RELAY_BACKOFF_MAX);
    }
  }
}

export function makeServer(cfg: Config, configPath: string, control?: SoloistControl): Promise<RunningProxy> {
  const { host, port } = listenParts(cfg.proxy.listen);
  const hub = new SoloistHub(() => `ws://${cfg.soloistWs}`);
  attachAutoplay(hub, cfg);
  const stats = attachWebhooks(hub, cfg);
  const relay = new SoloistRelay(hub, cfg);
  const wss = new WebSocketServer({ noServer: true });

  // Broadcast the (possibly changed) Overlay Config to open overlays so they restyle
  // live on save — no reload needed in OBS — and re-dial the Relay if its url/auth changed.
  const onConfigChange = (c: Config) => {
    hub.broadcastMessage({ type: "overlay_config", overlay: c.overlay });
    relay.apply();
  };
  const server = createServer((req, res) => {
    if (!handleWebRequest(req, res, cfg, configPath, stats, control, onConfigChange, relay.status)) res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  });

  server.on("upgrade", (req, socket, head) => {
    const tier = checkAuth(req, cfg);
    if (tier === "none") {
      log("rejected connection from %s: bad/missing token", req.socket.remoteAddress);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nUnauthorized\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      hub.register(client, { readOnly: tier === "readonly" });
      client.on("message", (data, isBinary) => hub.forward(client, data, isBinary));
      client.on("close", () => hub.unregister(client));
      client.on("error", () => hub.unregister(client));
    });
  });

  const hubRun = hub.run();
  hubRun.catch((e) => log("hub crashed: %s", (e as Error).message));

  const relayRun = relay.run();
  relayRun.catch((e) => log("relay crashed: %s", (e as Error).message));

  // Boot-time fan-out: link soloist-sink:monitor to the configured Audio Outputs.
  // Fire-and-forget — it waits/retries for target nodes and must not block listen.
  void reconcileOutputs(cfg).catch((e) => log("boot reconcile failed: %s", (e as Error).message));

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
            relay.stop();
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}

export async function serveProxy(cfg: Config, configPath: string, signal: AbortSignal, control?: SoloistControl): Promise<void> {
  const running = await makeServer(cfg, configPath, control);
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  await running.close();
}
