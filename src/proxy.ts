// Fronts Soloist's unauthenticated localhost-only control WS with token auth (ADR-0001).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";
import type { SoloistControl } from "./supervisor.js";
import { sameOrigin, resolveAuth, type ClientAuth } from "./auth.js";
import { AppControl, APP_CONTROL_PATH, appControlAllowed } from "./appcontrol.js";
import { attachWebhooks, STATE_EVENTS, WebhookHistory, type WebhookDelivery } from "./webhooks.js";
import { SoloistRelay, type RelayStatus } from "./relay.js";
import { handleWebRequest } from "./web.js";
import { reconcileOutputs, startSinkPolling } from "./pipewire.js";
import { isDockerMode } from "./runtime.js";
import { deferred } from "./util.js";
import { makeLog } from "./log.js";
import type { ClientMeta, ProxyStatus } from "./wire-contract.js";

export type { ClientMeta, ProxyStatus } from "./wire-contract.js";

const log = makeLog("proxy");

const HUB_BACKOFF_BASE = 0.5;
const HUB_BACKOFF_MAX = 30.0;
const HUB_READY_TIMEOUT = 5.0;

// Heartbeat for the proxy_status diagnostic stream. Eager pushes on client churn keep it
// fresh between beats; this only bounds staleness of the fields that change on their own.
const PROXY_STATUS_INTERVAL_MS = 3000;

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
    if (this.clients.get(client)?.tier === "readonly") return; // read-only tier never reaches upstream
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
    for (const client of this.clients.keys()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      } else {
        this.clients.delete(client);
      }
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
  appControl: AppControl;
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

// A delivery "succeeded" only if it got a response with a 2xx status; a network/timeout
// error (status null) or any non-2xx counts as not ok.
function webhookOk(d: WebhookDelivery): boolean {
  return d.error === null && d.status !== null && d.status >= 200 && d.status < 300;
}

// Compact Proxy Status snapshot for the `proxy_status` diagnostic stream. The webhook field
// carries the last delivery's summary only — timestamp, type, HTTP status, ok — never its
// headers or body; full-detail webhook history rides the separate `webhooks` stream (ADR-0016).
export function buildProxyStatus(
  hub: SoloistHub,
  relay: RelayStatus,
  history: WebhookHistory,
  control?: SoloistControl,
): ProxyStatus {
  const last = history.last();
  return {
    soloist: {
      state: control?.soloistStatus().state ?? null,
      upstream: hub.upstreamConnected,
      loggedIn: hub.loggedIn(),
    },
    clients: hub.clientCount(),
    relay,
    webhook: last ? { at: last.at, type: last.type, status: last.status, ok: webhookOk(last) } : null,
  };
}

export function makeServer(cfg: Config, configPath: string, control?: SoloistControl): Promise<RunningProxy> {
  const { host, port } = listenParts(cfg.proxy.listen);
  const hub = new SoloistHub(() => `ws://${cfg.soloistWs}`);
  attachAutoplay(hub, cfg);
  const history = attachWebhooks(hub, cfg);
  const relay = new SoloistRelay(hub, cfg);
  const appControl = new AppControl(cfg);
  const wss = new WebSocketServer({ noServer: true });

  // Broadcast the (possibly changed) Overlay Config to open overlays so they restyle
  // live on save — no reload needed in OBS — and re-dial the Relay if its url/auth changed.
  const onConfigChange = (c: Config) => {
    hub.broadcastMessage({ type: "overlay_config", overlay: c.overlay });
    relay.apply();
  };

  // Diagnostic streams over the App-Control WS: Debug Subscribers only, never
  // hub.broadcastMessage (that is the pure `/` Downstream path) or the Relay (ADR-0016).
  const publishProxyStatus = () => appControl.publish("proxy_status", buildProxyStatus(hub, relay.status, history, control));
  // frame: every upstream Soloist frame mirrored out (output only — clients never feed this).
  hub.observe((frame) => appControl.publish("frame", frame.message));
  // webhooks: live full-detail deliveries as they land (initial dump handled on subscribe).
  const unlistenWebhooks = history.onEntry((d) => appControl.publish("webhooks", d));
  // On subscribe, seed the new socket with the current snapshot so a diagnostics UI paints
  // immediately instead of waiting for the next change/heartbeat.
  appControl.onSubscribe((stream, send) => {
    if (stream === "proxy_status") send(buildProxyStatus(hub, relay.status, history, control));
    else if (stream === "clients") send(hub.clientList());
    else if (stream === "webhooks") send(history.entries());
  });
  const statusTimer = setInterval(publishProxyStatus, PROXY_STATUS_INTERVAL_MS);
  statusTimer.unref?.();

  const server = createServer((req, res) => {
    if (!handleWebRequest(req, res, cfg, configPath, control, onConfigChange, relay.status, (r) => appControl.closeForRequest(r))) res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // App-Control WebSocket: operator-only diagnostics on a session cookie + same-host
    // origin (no tokens). Registered as a Debug Subscriber, never a Downstream Client.
    if (path === APP_CONTROL_PATH) {
      if (!appControlAllowed(req, cfg)) {
        log("rejected app-control upgrade from %s: no session or cross-origin", req.socket.remoteAddress);
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden\n");
        socket.destroy();
        return;
      }
      appControl.handleUpgrade(req, socket, head);
      return;
    }
    const { tier, auth } = resolveAuth(req, cfg);
    if (tier === "none") {
      log("rejected connection from %s: bad/missing token", req.socket.remoteAddress);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nUnauthorized\n");
      socket.destroy();
      return;
    }
    // A cookie-authed upgrade must be same-origin, or a malicious page could ride the
    // ambient session cookie into full control (cross-site WebSocket hijacking). Keyed on
    // the derived auth kind, not token presence: a bogus token alongside a valid cookie
    // still resolves to session-cookie and must not slip past this gate.
    if (auth === "session-cookie" && !sameOrigin(req)) {
      log("rejected cookie upgrade from %s: cross-origin", req.socket.remoteAddress);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      hub.register(client, {
        id: randomUUID(),
        remoteAddr: req.socket.remoteAddress ?? "",
        tier,
        auth: auth as ClientAuth,
        connectedAt: Date.now(),
        userAgent: req.headers["user-agent"] ?? "",
      });
      // Eager diagnostic push: a Downstream Client join/leave changes the Client Count and
      // list, so refresh Debug Subscribers now rather than waiting for the heartbeat.
      publishProxyStatus();
      appControl.publish("clients", hub.clientList());
      // ws emits `close` after `error`, so fire once: one disconnect is one diagnostic event.
      let gone = false;
      const onGone = () => {
        if (gone) return;
        gone = true;
        hub.unregister(client);
        publishProxyStatus();
        appControl.publish("clients", hub.clientList());
      };
      client.on("message", (data, isBinary) => hub.forward(client, data, isBinary));
      client.on("close", onGone);
      client.on("error", onGone);
    });
  });

  const hubRun = hub.run();
  hubRun.catch((e) => log("hub crashed: %s", (e as Error).message));

  const relayRun = relay.run();
  relayRun.catch((e) => log("relay crashed: %s", (e as Error).message));

  // Docker only (ADR-0011/0015): the Snapcast + hardware fan-out and its sink cache. In
  // standalone there is no soloist-sink to reconcile — Soloist outputs to its device direct.
  if (isDockerMode()) {
    // Boot-time fan-out: link soloist-sink:monitor to the configured Audio Outputs.
    // Fire-and-forget — it waits/retries for target nodes and must not block listen.
    void reconcileOutputs(cfg).catch((e) => log("boot reconcile failed: %s", (e as Error).message));
    // Keep the Audio page's sink list warm so it paints populated (see startSinkPolling).
    startSinkPolling(cfg);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log("proxy listening on %s -> ws://%s", cfg.proxy.listen, cfg.soloistWs);
      resolve({
        server,
        hub,
        appControl,
        close: async () => {
          // Ordered teardown: stop the proxy_status heartbeat and drop the webhook observer,
          // stop the Hub (ends its reconnect loop and disposes every observer subscription),
          // stop the Relay, then tear down the App-Control tier — clear its re-check interval,
          // terminate every Debug Subscriber socket, and await its WebSocketServer close —
          // before closing the Downstream WSS and HTTP server.
          clearInterval(statusTimer);
          unlistenWebhooks();
          hub.stop();
          relay.stop();
          await appControl.stop();
          wss.close();
          await new Promise<void>((res) => server.close(() => res()));
        },
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
