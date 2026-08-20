// The Proxy: an authenticating WebSocket front for the Soloist WebSocket.
//
// Soloist's control WS is unauthenticated and localhost-only (ADR-0001). This
// server listens on proxy.listen, gates each connection on the shared Auth Token
// (`Authorization: Bearer <token>` header or `?token=<token>` query, constant-time
// compared), and relays frames verbatim. It is a dumb pipe — only authentication.
//
// Many Downstream Clients fan out against a single shared Soloist connection
// (SoloistHub): one upstream WS, every upstream frame broadcast to all clients,
// every client frame forwarded onto that one upstream. Reconnects with backoff.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`${new Date().toISOString()} soloist.proxy ${msg}`, ...args);

const BEARER = "Bearer ";

// Upstream reconnect/backoff for the shared Soloist connection.
const HUB_BACKOFF_BASE = 0.5;
const HUB_BACKOFF_MAX = 30.0;
const HUB_READY_TIMEOUT = 5.0;

// Pull the Auth Token from the Bearer header, else the ?token= query.
export function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith(BEARER)) return auth.slice(BEARER.length);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

// Constant-time token check. False on missing token or length/value mismatch.
export function checkAuth(req: IncomingMessage, token: string): boolean {
  const presented = presentedToken(req);
  if (presented === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A single shared upstream connection to Soloist, fanned out to N clients.
export class SoloistHub {
  readonly url: string;
  private clients = new Set<WebSocket>();
  private conn: WebSocket | null = null;
  private ready: { promise: Promise<void>; resolve: () => void };
  private stopped = false;

  constructor(url: string) {
    this.url = url;
    this.ready = deferred();
  }

  register(client: WebSocket): void {
    this.clients.add(client);
  }

  unregister(client: WebSocket): void {
    this.clients.delete(client);
  }

  // Send one client frame to the shared upstream (dropped if it never comes up).
  async forward(data: RawData, isBinary: boolean): Promise<void> {
    const timedOut = Symbol();
    const winner = await Promise.race([this.ready.promise, sleep(HUB_READY_TIMEOUT * 1000).then(() => timedOut)]);
    if (winner === timedOut) return;
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    conn.send(data, { binary: isBinary });
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

  // Maintain the single upstream connection, broadcasting to clients, forever.
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
          });
          conn.on("message", (data, isBinary) => this.broadcast(data, isBinary));
          conn.on("error", (err) => reject(err));
          conn.on("close", () => resolve());
        });
      } catch (err) {
        log("soloist upstream %s error: %s", this.url, (err as Error).message);
      } finally {
        this.conn = null;
        this.ready = deferred(); // next forward() waits for the new connection
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

// Start the shared hub and the Proxy server; resolves once listening.
export function makeServer(cfg: Config): Promise<RunningProxy> {
  const { host, port } = listenParts(cfg.proxy.listen);
  const hub = new SoloistHub(`ws://${cfg.soloistWs}`);
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer(); // WS-only; the 'upgrade' handler below does the work

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

// Run the Proxy until the signal is aborted.
export async function serveProxy(cfg: Config, signal: AbortSignal): Promise<void> {
  const running = await makeServer(cfg);
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  await running.close();
}
