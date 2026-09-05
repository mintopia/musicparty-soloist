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

// CSWSH defense for cookie-authenticated upgrades: a browser always sends Origin on a
// WebSocket handshake, so require it to match the Host we were reached on. Token clients
// (presentedToken !== null) are exempt — they're not browsers and carry no ambient cookie.
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers["origin"];
  const host = req.headers["host"];
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
