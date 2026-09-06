import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import { safeStrEqual } from "./util.js";

export const SESSION_COOKIE = "soloist_session";

// Session cookie carries an issued-at timestamp so a signed cookie can't be replayed
// forever with no revocation — anything older than this is rejected outright.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Derives the MAC key from the session secret AND the current password, so rotating the
// password (e.g. because it leaked) revokes every live session. The password stays in the
// key, never the visible payload. `pwBinding` defaults to "" for callers that don't bind.
function sessionKey(secret: string, pwBinding: string): Buffer {
  return createHmac("sha256", secret).update("pw\0").update(pwBinding).digest();
}

export function signSession(username: string, secret: string, pwBinding = ""): string {
  const payload = `${username}|${Date.now()}`;
  const p = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", sessionKey(secret, pwBinding)).update(p).digest("base64url");
  return `${p}.${mac}`;
}

export function verifySession(token: string, secret: string, pwBinding = ""): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const p = token.slice(0, dot);
  const expected = createHmac("sha256", sessionKey(secret, pwBinding)).update(p).digest();
  let got: Buffer;
  try {
    got = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  const payload = Buffer.from(p, "base64url").toString();
  const sep = payload.lastIndexOf("|");
  if (sep < 0) return null;
  const issuedAt = Number(payload.slice(sep + 1));
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;
  return payload.slice(0, sep);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function webConfigured(cfg: Config): boolean {
  return cfg.web.username !== "" && cfg.web.password !== "";
}

export function sessionUser(req: IncomingMessage, cfg: Config): string | null {
  if (!webConfigured(cfg)) return null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const user = verifySession(token, cfg.web.sessionSecret, cfg.web.password);
  return user !== null && safeStrEqual(user, cfg.web.username) ? user : null;
}
