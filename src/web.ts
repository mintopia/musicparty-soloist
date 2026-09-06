import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigError, applyApiConfig, configSummary, hashPassword, isPasswordHashed, maskConfig, saveConfig, verifyPassword, type Config } from "./config.js";
import type { RelayStatus } from "./relay.js";
import type { SoloistControl } from "./supervisor.js";
import { getSinkCache, refreshSinkCache, reconcileOutputs, listStandaloneSinks } from "./pipewire.js";
import { isDockerMode } from "./runtime.js";
import { restartSnapserver, snapcastNeedsRestart } from "./snapserver.js";
import { safeStrEqual } from "./util.js";
import { SESSION_COOKIE, signSession, sessionUser, webConfigured } from "./session.js";
import { makeLog } from "./log.js";

const log = makeLog("web");

const MAX_BODY = 8 * 1024;

const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));
const WEB_ROOT = resolve(WEB_DIR);

const APP_PATHS = new Set(["/", "/audio", "/webhooks", "/debug", "/lyrics", "/settings"]);

// Secrets the Landing Page may reveal on demand (eye toggle), each with a typed
// accessor keyed by its "section.key". Deliberately not the password (a scrypt hash)
// or the session secret — only operator-facing plaintext.
const REVEALABLE = new Map<string, (cfg: Config) => string>([
  ["soloist.apiKey", (cfg) => cfg.soloist.apiKey],
  ["proxy.token", (cfg) => cfg.proxy.token],
  ["relay.authorization", (cfg) => cfg.relay.authorization],
]);

const CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

// The resolved path is confined to WEB_ROOT so a crafted "/assets/../.." can't escape
// it — path traversal is impossible.
function serveAsset(res: ServerResponse, urlPath: string): void {
  const full = resolve(WEB_ROOT, "." + urlPath);
  if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403).end("Forbidden\n");
    return;
  }
  const ext = full.slice(full.lastIndexOf(".") + 1);
  let body: Buffer;
  try {
    body = readFileSync(full);
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

// Embeds only the Read-only Token and the Overlay Config subset — never the whole
// Config File. `<` is escaped so the JSON can't break out of the <script> element.
export function overlayBootstrap(cfg: Config): string {
  const data = { token: cfg.proxy.readonlyToken, overlay: cfg.overlay };
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script>window.__SOLOIST_OVERLAY__=${payload};</script>`;
}

function serveOverlay(res: ServerResponse, cfg: Config): void {
  let html: string;
  try {
    html = readFileSync(WEB_DIR + "overlay.html", "utf8");
  } catch {
    res.writeHead(404).end("Not found\n");
    return;
  }
  // Function replacer: a `$` in an Overlay Config value must not be read as a
  // replace-pattern token ($$, $&, ...).
  html = html.replace("<!--__OVERLAY_BOOTSTRAP__-->", () => overlayBootstrap(cfg));
  res.writeHead(200, { "content-type": CONTENT_TYPES.html }).end(html);
}

// Relay config (never the Authorization value) plus live connection status.
export function relayView(cfg: Config, status?: RelayStatus): unknown {
  const r = cfg.relay;
  return {
    config: { url: r.url, hasAuth: r.authorization !== "" },
    status: status ?? { enabled: r.url !== "", connected: false, lastConnectAt: null, lastError: null },
  };
}

function failClosed(res: ServerResponse): void {
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(
    "Web UI not configured: complete first-run setup at /setup.\n",
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
  const token = signSession(cfg.web.username, cfg.web.sessionSecret, cfg.web.password);
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`);
}

function apiAuthed(req: IncomingMessage, res: ServerResponse, cfg: Config): boolean {
  if (!webConfigured(cfg)) return failClosed(res), false;
  if (!sessionUser(req, cfg)) return json(res, 401, { error: "unauthenticated" }), false;
  return true;
}

async function handlePutConfig(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  configPath: string,
  onConfigChange?: (cfg: Config) => void,
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
    log.error("config save failed: %s", (err as Error).message);
    return json(res, 500, { error: "failed to save config" });
  }
  Object.assign(cfg, next);
  log("config saved and applied live");
  // Docker only; fire-and-forget so the save isn't held on pw-link.
  if (isDockerMode()) void reconcileOutputs(cfg).catch((err) => log.error("reconcile after save failed: %s", (err as Error).message));
  onConfigChange?.(cfg);
  json(res, 200, maskConfig(cfg));
}

async function handlePipewireSinks(req: IncomingMessage, res: ServerResponse, cfg: Config): Promise<void> {
  const force = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
  try {
    if (isDockerMode()) {
      const cache = force || getSinkCache().refreshedAt === 0 ? await refreshSinkCache(cfg) : getSinkCache();
      json(res, 200, cache);
    } else {
      json(res, 200, { sinks: await listStandaloneSinks(), refreshedAt: Date.now() });
    }
  } catch (err) {
    log.error("pw-dump failed: %s", (err as Error).message);
    json(res, 500, { error: "failed to enumerate sinks" });
  }
}

// TOCTOU guard: two concurrent POST /setup can both observe webConfigured() === false
// before either has saved. One claim per config path — this app targets exactly one,
// but the latch is keyed so tests covering several don't collide.
const setupClaimed = new Set<string>();

// The client mirrors this; the server is the authority since form JS can be bypassed.
export const MIN_PASSWORD_LENGTH = 8;

// Runs only while web creds are unset (gated in handleWebRequest), so it never
// overwrites live creds.
async function handleSetup(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  configPath: string,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413).end("Payload too large\n");
    return;
  }
  const form = new URLSearchParams(body);
  const username = (form.get("username") ?? "").trim();
  const password = form.get("password") ?? "";
  const confirm = form.get("confirm") ?? "";
  if (username === "" || password.length < MIN_PASSWORD_LENGTH || password !== confirm) {
    redirect(res, "/setup?error=1");
    return;
  }
  // Concurrent POST could have set creds already; don't clobber an established account.
  if (webConfigured(cfg)) {
    redirect(res, "/login");
    return;
  }
  if (setupClaimed.has(configPath)) {
    redirect(res, "/setup?error=1");
    return;
  }
  setupClaimed.add(configPath);
  const next = structuredClone(cfg);
  next.web.username = username;
  next.web.password = hashPassword(password);
  try {
    saveConfig(configPath, next);
  } catch (err) {
    log.error("setup save failed: %s", (err as Error).message);
    setupClaimed.delete(configPath); // save failed — allow a retry to claim it
    res.writeHead(500).end("Failed to save setup\n");
    return;
  }
  Object.assign(cfg, next);
  log("first-run setup complete: web creds set for %s", username);
  setSession(res, cfg);
  redirect(res, "/");
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, cfg: Config, configPath: string): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413).end("Payload too large\n");
    return;
  }
  const form = new URLSearchParams(body);
  const password = form.get("password") ?? "";
  const okUser = safeStrEqual(form.get("username") ?? "", cfg.web.username);
  const okPass = verifyPassword(password, cfg.web.password);
  if (okUser && okPass) {
    // Upgrade a legacy cleartext password to a hash on first successful login.
    if (!isPasswordHashed(cfg.web.password)) {
      try {
        const next = structuredClone(cfg);
        next.web.password = hashPassword(password);
        saveConfig(configPath, next);
        Object.assign(cfg, next);
        log("rehashed legacy web password to scrypt");
      } catch (err) {
        log.error("password rehash failed: %s", (err as Error).message);
      }
    }
    setSession(res, cfg);
    log("login ok for %s", cfg.web.username);
    redirect(res, "/");
    return;
  }
  log.warn("login failed from %s", req.socket.remoteAddress);
  redirect(res, "/login?error=1");
}

// Returns true if it handled the request; false to let the caller 404/fall through.
export function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  configPath: string,
  control?: SoloistControl,
  onConfigChange?: (cfg: Config) => void,
  relayStatus?: RelayStatus,
  onLogout?: (req: IncomingMessage) => void,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!webConfigured(cfg)) {
    if (path === "/setup" && method === "GET") return serveAsset(res, "/setup.html"), true;
    if (path === "/setup" && method === "POST") return void handleSetup(req, res, cfg, configPath), true;
    if (method === "GET" && path.startsWith("/assets/")) return serveAsset(res, path), true;
    if (method === "GET" && !path.startsWith("/api/")) return redirect(res, "/setup"), true;
    return failClosed(res), true;
  }
  if (path === "/setup") return redirect(res, "/"), true;

  // Unauthenticated: no secrets ship in these files.
  if (method === "GET" && (path.startsWith("/assets/") || path === "/overlay.js" || path === "/frame.js")) {
    serveAsset(res, path);
    return true;
  }

  // Open (unauthenticated): the overlay embeds the Read-only Token server-side.
  if (path === "/overlay" && method === "GET") {
    serveOverlay(res, cfg);
    return true;
  }

  if (path === "/api/relay" && method === "GET") {
    if (apiAuthed(req, res, cfg)) json(res, 200, relayView(cfg, relayStatus));
    return true;
  }

  if (path === "/api/config" && method === "GET") {
    if (apiAuthed(req, res, cfg)) json(res, 200, maskConfig(cfg));
    return true;
  }

  if (path === "/api/config" && method === "PUT") {
    if (apiAuthed(req, res, cfg)) void handlePutConfig(req, res, cfg, configPath, onConfigChange);
    return true;
  }

  if (path === "/api/config-summary" && method === "GET") {
    if (apiAuthed(req, res, cfg)) {
      json(res, 200, {
        ...configSummary(cfg),
        pendingRestart: control?.pendingRestart(cfg) ?? false,
        pendingSnapcastRestart: isDockerMode() && snapcastNeedsRestart(cfg),
        dockerMode: isDockerMode(),
      });
    }
    return true;
  }

  // Session-gated; returns 404 for any path outside the REVEALABLE allowlist.
  if (path === "/api/secret" && method === "GET") {
    if (!apiAuthed(req, res, cfg)) return true;
    const reveal = REVEALABLE.get(`${url.searchParams.get("section")}.${url.searchParams.get("key")}`);
    if (!reveal) return json(res, 404, { error: "not revealable" }), true;
    json(res, 200, { value: reveal(cfg) });
    return true;
  }

  if (path === "/api/restart-soloist" && method === "POST") {
    if (apiAuthed(req, res, cfg)) {
      control?.restart(cfg);
      log("restart-soloist requested via API");
      json(res, 200, { ok: true, pendingRestart: false });
    }
    return true;
  }

  if (path === "/api/restart-snapcast" && method === "POST") {
    if (apiAuthed(req, res, cfg)) {
      if (!isDockerMode()) return json(res, 400, { error: "not in docker mode" }), true;
      restartSnapserver(cfg).then(
        () => json(res, 200, { ok: true, pendingSnapcastRestart: false }),
        (err) => json(res, 500, { error: (err as Error).message }),
      );
    }
    return true;
  }

  if (path === "/api/pipewire-sinks" && method === "GET") {
    if (apiAuthed(req, res, cfg)) void handlePipewireSinks(req, res, cfg);
    return true;
  }

  if (path === "/login" && method === "GET") {
    if (sessionUser(req, cfg)) return redirect(res, "/"), true;
    serveAsset(res, "/login.html");
    return true;
  }

  if (path === "/login" && method === "POST") {
    void handleLogin(req, res, cfg, configPath);
    return true;
  }

  if (path === "/logout" && method === "POST") {
    // Close any live App-Control sockets on this session before the cookie is cleared, so a
    // logout revokes the diagnostics channel too.
    onLogout?.(req);
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    redirect(res, "/login");
    return true;
  }

  if ((APP_PATHS.has(path) || path.startsWith("/settings/")) && method === "GET") {
    if (!sessionUser(req, cfg)) return redirect(res, "/login"), true;
    serveAsset(res, "/index.html");
    return true;
  }

  return false;
}
