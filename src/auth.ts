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

export function checkAuth(req: IncomingMessage, cfg: Config): AuthTier {
  const presented = presentedToken(req);
  if (presented !== null) {
    if (tokenEquals(presented, cfg.proxy.token)) return "control";
    if (tokenEquals(presented, cfg.proxy.readonlyToken)) return "readonly";
  }
  if (sessionUser(req, cfg)) return "control";
  return "none";
}
