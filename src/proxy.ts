// Fronts Soloist's unauthenticated localhost-only control WS with token auth (ADR-0001).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";
import type { SoloistControl } from "./supervisor.js";
import { checkAuth, presentedToken, sameOrigin } from "./auth.js";
import { attachWebhooks, STATE_EVENTS } from "./webhooks.js";
import { SoloistRelay, type RelayStatus } from "./relay.js";
import { handleWebRequest } from "./web.js";
import { reconcileOutputs, startSinkPolling } from "./pipewire.js";
import { deferred } from "./util.js";
import { makeLog } from "./log.js";

const log = makeLog("proxy");

const HUB_BACKOFF_BASE = 0.5;
const HUB_BACKOFF_MAX = 30.0;
const HUB_READY_TIMEOUT = 5.0;

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

  private signalWake(): void {
    this.wake.resolve();
    this.wake = deferred();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
    this.signalWake();
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
      // Backoff, but wake early on stop() so shutdown never waits out the cap.
      await Promise.race([sleep(backoff * 1000), this.wake.promise]);
      backoff = Math.min(backoff * 2, HUB_BACKOFF_MAX);
    }
  }
}

// Parses "HOST:PORT" from the last colon, so an IPv6 literal like "[::1]:8687" still
// splits at the port separator rather than an inner colon. Surrounding brackets are
// stripped: server.listen wants "::1", not "[::1]".
export function listenParts(listen: string): { host: string; port: number } {
  const i = listen.lastIndexOf(":");
  if (i < 0) throw new Error(`invalid proxy.listen "${listen}": expected HOST:PORT`);
  const host = (listen.slice(0, i) || "0.0.0.0").replace(/^\[(.*)\]$/, "$1");
  const port = Number(listen.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid proxy.listen "${listen}": bad port`);
  }
  return { host, port };
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
    // A cookie-authed (tokenless) upgrade must be same-origin, or a malicious page could
    // ride the ambient session cookie into full control (cross-site WebSocket hijacking).
    if (presentedToken(req) === null && !sameOrigin(req)) {
      log("rejected cookie upgrade from %s: cross-origin", req.socket.remoteAddress);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden\n");
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

  // Keep the Audio page's sink list warm so it paints populated (see startSinkPolling).
  startSinkPolling(cfg);

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
