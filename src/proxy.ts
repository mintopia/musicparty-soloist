// Fronts Soloist's unauthenticated localhost-only control WS with token auth (ADR-0001).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";

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

// A decoded upstream frame handed to observers. Autoplay reads `message`;
// webhooks POST `raw` verbatim. Only text frames with a string `type` decode.
export interface UpstreamFrame {
  type: string;
  message: Record<string, unknown>;
  raw: string;
}

export type FrameObserver = (frame: UpstreamFrame) => void;

// Returns null for binary, non-JSON, or type-less frames — those bypass
// observers but are still broadcast unchanged.
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
  readonly url: string;
  private clients = new Set<WebSocket>();
  private observers = new Set<FrameObserver>();
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

  // Decode once, dispatch to observers, then broadcast the original bytes
  // unchanged. An observer throwing must never break relay.
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

export function makeServer(cfg: Config): Promise<RunningProxy> {
  const { host, port } = listenParts(cfg.proxy.listen);
  const hub = new SoloistHub(`ws://${cfg.soloistWs}`);
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
