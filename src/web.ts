// Web Session auth + HTTP router for the Landing Page (ADR-0009, ADR-0010).
// Login form -> signed HttpOnly cookie; middleware gates the Landing Page and,
// in proxy.ts, the control-tier WS upgrade. Fails closed when web creds unset.

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigError, applyApiConfig, configSummary, maskConfig, saveConfig, type Config } from "./config.js";
import type { WebhookStats } from "./proxy.js";
import { makeLog } from "./log.js";

const log = makeLog("web");

export const SESSION_COOKIE = "soloist_session";
const MAX_BODY = 8 * 1024;

// dist/web/, sibling of the compiled dist/web.js — populated by the build copy step.
const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));

// Fixed allowlist: exact request path -> filename under WEB_DIR. No user-controlled
// path segment ever reaches the filesystem, so path traversal is impossible.
const STATIC: Record<string, string> = {
  "/app.css": "app.css",
};

const CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signSession(payload: string, secret: string): string {
  const p = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", secret).update(p).digest("base64url");
  return `${p}.${mac}`;
}

export function verifySession(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const p = token.slice(0, dot);
  const expected = createHmac("sha256", secret).update(p).digest();
  let got: Buffer;
  try {
    got = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return Buffer.from(p, "base64url").toString();
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

// Configured username who owns a valid Web Session on this request, else null.
export function sessionUser(req: IncomingMessage, cfg: Config): string | null {
  if (!webConfigured(cfg)) return null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const user = verifySession(token, cfg.web.sessionSecret);
  return user !== null && safeEqual(user, cfg.web.username) ? user : null;
}

export function webConfigured(cfg: Config): boolean {
  return cfg.web.username !== "" && cfg.web.password !== "";
}

function serveFile(res: ServerResponse, name: string): void {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  let body: Buffer;
  try {
    body = readFileSync(WEB_DIR + name);
  } catch {
    res.writeHead(404).end("Not found\n");
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" }).end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location }).end();
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(obj));
}

// Configured webhook destinations (never the secret value) plus live delivery stats.
export function webhooksView(cfg: Config, stats: WebhookStats): unknown {
  const wh = cfg.webhooks;
  return {
    config: { defaultUrl: wh.defaultUrl, urls: wh.urls, hasSecret: wh.secret !== "" },
    stats: Object.fromEntries(stats),
  };
}

function failClosed(res: ServerResponse): void {
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(
    "Web UI not configured: set web.username and web.password in config.yaml.\n",
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// No Secure flag: the Proxy is commonly reached over plain HTTP on the LAN, so
// requiring HTTPS would silently break login. HttpOnly + SameSite=Lax stand.
function setSession(res: ServerResponse, cfg: Config): void {
  const token = signSession(cfg.web.username, cfg.web.sessionSecret);
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`);
}

// Gate the config/control API behind a valid Web Session. Writes the response and
// returns false when unauthorized; returns true to proceed.
function apiAuthed(req: IncomingMessage, res: ServerResponse, cfg: Config): boolean {
  if (!webConfigured(cfg)) return failClosed(res), false;
  if (!sessionUser(req, cfg)) return json(res, 401, { error: "unauthenticated" }), false;
  return true;
}

// Validate → persist → apply hot fields live by mutating the shared Config in
// place (tokens, sessionUser, webhooks, autoplay, overlay all read it live).
async function handlePutConfig(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  configPath: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return json(res, 413, { error: "body too large" });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "invalid JSON" });
  }
  let next: Config;
  try {
    next = applyApiConfig(cfg, body);
    saveConfig(configPath, next);
  } catch (err) {
    if (err instanceof ConfigError) return json(res, 400, { error: err.message });
    // Handler is floated (void handlePutConfig); a re-throw here would be an
    // unhandled rejection and the client would hang. Log and 500 instead.
    log("config save failed: %s", (err as Error).message);
    return json(res, 500, { error: "failed to save config" });
  }
  Object.assign(cfg, next);
  log("config saved and applied live");
  json(res, 200, maskConfig(cfg));
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, cfg: Config): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413).end("Payload too large\n");
    return;
  }
  const form = new URLSearchParams(body);
  const okUser = safeEqual(form.get("username") ?? "", cfg.web.username);
  const okPass = safeEqual(form.get("password") ?? "", cfg.web.password);
  if (okUser && okPass) {
    setSession(res, cfg);
    log("login ok for %s", cfg.web.username);
    redirect(res, "/");
    return;
  }
  log("login failed from %s", req.socket.remoteAddress);
  redirect(res, "/login?error=1");
}

// Returns true if it handled the request; false to let the caller 404/fall through.
export function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  configPath: string,
  stats: WebhookStats = new Map(),
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && STATIC[path]) {
    serveFile(res, STATIC[path]);
    return true;
  }

  if (path === "/api/webhooks" && method === "GET") {
    if (!webConfigured(cfg)) return failClosed(res), true;
    if (!sessionUser(req, cfg)) return json(res, 401, { error: "unauthorized" }), true;
    json(res, 200, webhooksView(cfg, stats));
    return true;
  }

  if (path === "/api/config" && method === "GET") {
    if (apiAuthed(req, res, cfg)) json(res, 200, maskConfig(cfg));
    return true;
  }

  if (path === "/api/config" && method === "PUT") {
    if (apiAuthed(req, res, cfg)) void handlePutConfig(req, res, cfg, configPath);
    return true;
  }

  if (path === "/api/config-summary" && method === "GET") {
    if (apiAuthed(req, res, cfg)) json(res, 200, configSummary(cfg));
    return true;
  }

  if (path === "/login" && method === "GET") {
    if (!webConfigured(cfg)) return failClosed(res), true;
    if (sessionUser(req, cfg)) return redirect(res, "/"), true;
    serveFile(res, "login.html");
    return true;
  }

  if (path === "/login" && method === "POST") {
    if (!webConfigured(cfg)) return failClosed(res), true;
    void handleLogin(req, res, cfg);
    return true;
  }

  if (path === "/logout" && method === "POST") {
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    redirect(res, "/login");
    return true;
  }

  if (path === "/" && method === "GET") {
    if (!webConfigured(cfg)) return failClosed(res), true;
    if (!sessionUser(req, cfg)) return redirect(res, "/login"), true;
    serveFile(res, "app.html");
    return true;
  }

  return false;
}
