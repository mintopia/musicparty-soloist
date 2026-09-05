// Auth-tier resolution for the Proxy: a presented Auth/Read-only Token, or a Web
// Session cookie (ADR-0001, ADR-0009).

import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import { sessionUser } from "./web.js";
import { safeStrEqual } from "./util.js";

const BEARER = "Bearer ";

export function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith(BEARER)) return auth.slice(BEARER.length);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

function tokenEquals(presented: string, token: string): boolean {
  if (!token) return false;
  return safeStrEqual(presented, token);
}

export type AuthTier = "control" | "readonly" | "none";

export type ClientAuth = "auth-token" | "readonly-token" | "session-cookie";

// Host-only by design: no scheme compare. A plain createServer behind a TLS-terminating
// proxy sees no reliable scheme on the request, and host-only already defeats CSWSH — a
// cross-site page can't forge a matching Host. So we compare hostname (case-insensitive)
// and port, treating the default ports (none/80/443) as equivalent.
const DEFAULT_PORTS = new Set(["", "80", "443"]);

function authority(value: string): { host: string; port: string } | null {
  try {
    // Parse the bare "host[:port]" (Host header) or a full Origin URL. Prefixing a scheme
    // makes "host:port" parse as authority, not "scheme:path".
    const u = new URL(value.includes("://") ? value : `http://${value}`);
    if (!u.hostname) return null;
    return { host: u.hostname.toLowerCase(), port: u.port };
  } catch {
    return null;
  }
}

// CSWSH defense for cookie-authenticated upgrades: a browser always sends Origin on a
// WebSocket handshake, so require its host to match the Host we were reached on. Token
// clients (presentedToken !== null) are exempt — they're not browsers and carry no cookie.
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers["origin"];
  const host = req.headers["host"];
  if (!origin || !host) return false;
  const o = authority(origin);
  const h = authority(host);
  if (!o || !h) return false;
  if (o.host !== h.host) return false;
  return o.port === h.port || (DEFAULT_PORTS.has(o.port) && DEFAULT_PORTS.has(h.port));
}

export function resolveAuth(req: IncomingMessage, cfg: Config): { tier: AuthTier; auth: ClientAuth | null } {
  const presented = presentedToken(req);
  if (presented !== null) {
    if (tokenEquals(presented, cfg.proxy.token)) return { tier: "control", auth: "auth-token" };
    if (tokenEquals(presented, cfg.proxy.readonlyToken)) return { tier: "readonly", auth: "readonly-token" };
  }
  if (sessionUser(req, cfg)) return { tier: "control", auth: "session-cookie" };
  return { tier: "none", auth: null };
}

export function checkAuth(req: IncomingMessage, cfg: Config): AuthTier {
  return resolveAuth(req, cfg).tier;
}
