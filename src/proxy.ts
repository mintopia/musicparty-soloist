// Fronts Soloist's unauthenticated localhost-only control WS with token auth (ADR-0001).

import { createServer, type Server, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { SoloistControl } from "./supervisor.js";
import { sameOrigin, resolveAuth, type ClientAuth } from "./auth.js";
import { AppControl, APP_CONTROL_PATH, appControlAllowed } from "./appcontrol.js";
import { attachWebhooks, WebhookHistory, type WebhookDelivery } from "./webhooks.js";
import { SoloistRelay, type RelayStatus } from "./relay.js";
import { handleWebRequest } from "./web.js";
import { reconcileOutputs, startSinkPolling } from "./pipewire.js";
import { isDockerMode } from "./runtime.js";
import { SoloistHub, type UpstreamFrame } from "./hub.js";
import { makeLog } from "./log.js";
import type { ClientMeta, ProxyStatus } from "./wire-contract.js";

export type { ClientMeta, ProxyStatus } from "./wire-contract.js";

const log = makeLog("proxy");

// Heartbeat for the proxy_status diagnostic stream. Eager pushes on client churn keep it
// fresh between beats; this only bounds staleness of the fields that change on their own.
const PROXY_STATUS_INTERVAL_MS = 3000;

export interface AutoplayState {
  fired: boolean;
}

export function shouldAutoplay(prev: AutoplayState, next: UpstreamFrame): boolean {
  return !prev.fired && next.type === "auth_state" && next.message.logged_in === true;
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
    if (frame.type === "error") log.error("autoplay: upstream error frame: %s", frame.raw);
    if (!shouldAutoplay(state, frame)) return;
    state.fired = true;
    log("autoplay: logged in, injecting activate then play");
    for (const autoplayFrame of AUTOPLAY_FRAMES) hub.inject(autoplayFrame);
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

interface DiagnosticsHandles {
  publishProxyStatus: () => void;
  statusTimer: ReturnType<typeof setInterval>;
  unlistenWebhooks: () => void;
}

// Diagnostic streams over the App-Control WS: Debug Subscribers only, never
// hub.broadcastMessage (that is the pure `/` Downstream path) or the Relay (ADR-0016).
function wireDiagnostics(
  hub: SoloistHub,
  relay: SoloistRelay,
  appControl: AppControl,
  history: WebhookHistory,
  control: SoloistControl | undefined,
): DiagnosticsHandles {
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
  return { publishProxyStatus, statusTimer, unlistenWebhooks };
}

function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  cfg: Config,
  hub: SoloistHub,
  appControl: AppControl,
  wss: WebSocketServer,
  publishProxyStatus: () => void,
): void {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  // App-Control WebSocket: operator-only diagnostics on a session cookie + same-host
  // origin (no tokens). Registered as a Debug Subscriber, never a Downstream Client.
  if (path === APP_CONTROL_PATH) {
    if (!appControlAllowed(req, cfg)) {
      log.warn("rejected app-control upgrade from %s: no session or cross-origin", req.socket.remoteAddress);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden\n");
      socket.destroy();
      return;
    }
    appControl.handleUpgrade(req, socket, head);
    return;
  }
  const { tier, auth } = resolveAuth(req, cfg);
  if (tier === "none") {
    log.warn("rejected connection from %s: bad/missing token", req.socket.remoteAddress);
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nUnauthorized\n");
    socket.destroy();
    return;
  }
  // A cookie-authed upgrade must be same-origin, or a malicious page could ride the
  // ambient session cookie into full control (cross-site WebSocket hijacking). Keyed on
  // the derived auth kind, not token presence: a bogus token alongside a valid cookie
  // still resolves to session-cookie and must not slip past this gate.
  if (auth === "session-cookie" && !sameOrigin(req)) {
    log.warn("rejected cookie upgrade from %s: cross-origin", req.socket.remoteAddress);
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
}

interface TeardownDeps {
  statusTimer: ReturnType<typeof setInterval>;
  unlistenWebhooks: () => void;
  hub: SoloistHub;
  relay: SoloistRelay;
  appControl: AppControl;
  wss: WebSocketServer;
  server: Server;
}

// Ordered teardown: stop the proxy_status heartbeat and drop the webhook observer,
// stop the Hub (ends its reconnect loop and disposes every observer subscription),
// stop the Relay, then tear down the App-Control tier — clear its re-check interval,
// terminate every Debug Subscriber socket, and await its WebSocketServer close —
// before closing the Downstream WSS and HTTP server.
function buildTeardown(deps: TeardownDeps): () => Promise<void> {
  return async () => {
    clearInterval(deps.statusTimer);
    deps.unlistenWebhooks();
    deps.hub.stop();
    deps.relay.stop();
    await deps.appControl.stop();
    deps.wss.close();
    await new Promise<void>((res) => deps.server.close(() => res()));
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

  const { publishProxyStatus, statusTimer, unlistenWebhooks } = wireDiagnostics(hub, relay, appControl, history, control);

  const server = createServer((req, res) => {
    if (!handleWebRequest(req, res, cfg, configPath, control, onConfigChange, relay.status, (r) => appControl.closeForRequest(r))) res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  });

  server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, cfg, hub, appControl, wss, publishProxyStatus));

  const hubRun = hub.run();
  hubRun.catch((e) => log.error("hub crashed: %s", (e as Error).message));

  const relayRun = relay.run();
  relayRun.catch((e) => log.error("relay crashed: %s", (e as Error).message));

  // Docker only (ADR-0011/0015): the Snapcast + hardware fan-out and its sink cache. In
  // standalone there is no soloist-sink to reconcile — Soloist outputs to its device direct.
  if (isDockerMode()) {
    // Boot-time fan-out: link soloist-sink:monitor to the configured Audio Outputs.
    // Fire-and-forget — it waits/retries for target nodes and must not block listen.
    void reconcileOutputs(cfg).catch((e) => log.error("boot reconcile failed: %s", (e as Error).message));
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
        close: buildTeardown({ statusTimer, unlistenWebhooks, hub, relay, appControl, wss, server }),
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
