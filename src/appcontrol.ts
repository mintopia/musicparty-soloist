import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "./config.js";
import { sameOrigin } from "./auth.js";
import { parseCookies, sessionUser, SESSION_COOKIE } from "./session.js";
import { makeLog } from "./log.js";
import { DEBUG_STREAMS, type DebugStream } from "./wire-contract.js";

const log = makeLog("appcontrol");

export const APP_CONTROL_PATH = "/ws/app";

// Control frames are tiny `{type:"subscribe",streams:[…]}` envelopes; a small cap keeps a
// hostile peer from buffering a large inbound frame. ws closes the socket (1009) itself.
export const APP_CONTROL_MAX_PAYLOAD = 4096;

export { DEBUG_STREAMS };
export type { DebugStream };
const VALID_STREAMS = new Set<string>(DEBUG_STREAMS);

// Post-upgrade auth lifecycle: a socket authed once at handshake must not live forever on
// a since-revoked session. Bound its max lifetime and re-validate the session periodically.
export const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const RECHECK_INTERVAL_MS = 60 * 1000;

// Backpressure: a slow consumer must never grow the Proxy's memory unbounded. Past the drop
// threshold we shed the high-rate `frame` stream first; past the hard threshold the socket
// is hopeless and gets closed.
export const BUFFER_DROP_BYTES = 1024 * 1024;
export const BUFFER_CLOSE_BYTES = 8 * 1024 * 1024;

// The single gate for an App-Control upgrade: a valid Web Session cookie AND same-host
// origin. Tokens are deliberately not accepted here (this tier is browser-only), and the
// same-origin check is the CSWSH defense for the ambient session cookie.
export function appControlAllowed(req: IncomingMessage, cfg: Config): boolean {
  return sessionUser(req, cfg) !== null && sameOrigin(req);
}

// One-way fingerprint of a request's session cookie, so POST /logout can match and close a
// subscriber's socket without storing or comparing the raw cookie across sockets.
export function sessionFingerprint(cookieHeader: string | undefined): string | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  return createHash("sha256").update(token).digest("base64url");
}

interface Subscriber {
  ws: WebSocket;
  fingerprint: string;
  cookie: string; // the raw Cookie header, kept private for the periodic sessionUser re-check
  streams: Set<string>;
  deadline: number;
}

export class AppControl {
  private subs = new Set<Subscriber>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: APP_CONTROL_MAX_PAYLOAD });
  private timer: ReturnType<typeof setInterval> | null = null;
  private subscribeHooks = new Set<(stream: DebugStream, send: (data: unknown) => void) => void>();

  // cfg is the live, mutated-in-place Config, so the re-check sees a rotated password.
  constructor(private cfg: Config) {}

  // Precondition: appControlAllowed(req, cfg) must already hold for this request.
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, req.headers.cookie ?? ""));
  }

  register(ws: WebSocket, cookieHeader: string): void {
    const fingerprint = sessionFingerprint(cookieHeader);
    if (!fingerprint) {
      try { ws.close(1008, "no session"); } catch { /* already closing */ }
      return;
    }
    const sub: Subscriber = {
      ws,
      fingerprint,
      cookie: cookieHeader,
      streams: new Set(),
      deadline: Date.now() + MAX_LIFETIME_MS,
    };
    this.subs.add(sub);
    ws.on("message", (data, isBinary) => this.onMessage(sub, data, isBinary));
    ws.on("close", () => this.subs.delete(sub));
    ws.on("error", () => this.close(sub, 1011, "socket error"));
    this.ensureTimer();
  }

  private onMessage(sub: Subscriber, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const m = msg as Record<string, unknown>;
    if (m.type !== "subscribe" || !Array.isArray(m.streams)) return;
    // Idempotent: only a newly-added stream fires the subscribe hooks, so a repeated
    // subscribe re-sends no snapshot. Unknown stream names are ignored rather than rejected.
    for (const s of m.streams) {
      if (typeof s !== "string" || !VALID_STREAMS.has(s) || sub.streams.has(s)) continue;
      sub.streams.add(s);
      const stream = s as DebugStream;
      for (const hook of this.subscribeHooks) {
        try {
          hook(stream, (data) => this.deliver(sub, stream, JSON.stringify({ stream, data })));
        } catch (err) {
          log.error("subscribe hook threw: %s", (err as Error).message);
        }
      }
    }
  }

  onSubscribe(cb: (stream: DebugStream, send: (data: unknown) => void) => void): void {
    this.subscribeHooks.add(cb);
  }

  publish(stream: DebugStream, data: unknown): void {
    if (this.subs.size === 0) return;
    const raw = JSON.stringify({ stream, data });
    for (const sub of this.subs) {
      if (sub.streams.has(stream)) this.deliver(sub, stream, raw);
    }
  }

  private deliver(sub: Subscriber, stream: DebugStream, raw: string): void {
    if (sub.ws.readyState !== WebSocket.OPEN) return;
    const buffered = sub.ws.bufferedAmount;
    if (buffered > BUFFER_CLOSE_BYTES) {
      log.warn("closing slow debug subscriber: %d bytes buffered", buffered);
      this.close(sub, 1013, "slow consumer");
      return;
    }
    if (buffered > BUFFER_DROP_BYTES && stream === "frame") return;
    sub.ws.send(raw);
  }

  closeForRequest(req: IncomingMessage): void {
    const fp = sessionFingerprint(req.headers.cookie);
    if (!fp) return;
    for (const sub of this.subs) if (sub.fingerprint === fp) this.close(sub, 1008, "logged out");
  }

  recheck(): void {
    const now = Date.now();
    for (const sub of this.subs) {
      if (now > sub.deadline) {
        this.close(sub, 1008, "session lifetime exceeded");
        continue;
      }
      const shim = { headers: { cookie: sub.cookie } } as unknown as IncomingMessage;
      if (sessionUser(shim, this.cfg) === null) this.close(sub, 1008, "session revoked");
    }
    if (this.subs.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  count(): number {
    return this.subs.size;
  }

  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const sub of this.subs) {
      try { sub.ws.close(1001, "shutting down"); } catch { /* already closing */ }
    }
    this.subs.clear();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.recheck(), RECHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private close(sub: Subscriber, code: number, reason: string): void {
    this.subs.delete(sub);
    try { sub.ws.close(code, reason); } catch { /* already closing */ }
  }
}
