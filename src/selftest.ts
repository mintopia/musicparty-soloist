import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { detectArch, AcquisitionError, tarballUrl } from "./acquire.js";
import { checkAuth, sameOrigin, resolveAuth } from "./auth.js";
import { safeStrEqual } from "./util.js";
import { backoffStep, BACKOFF_BASE, BACKOFF_MAX } from "./supervisor.js";
import { decodeFrame, shouldAutoplay, AUTOPLAY_FRAMES, SoloistHub, listenParts, buildProxyStatus, makeServer, type UpstreamFrame } from "./proxy.js";
import { resolveWebhookUrl, WebhookQueue, WebhookHistory, postWebhook, WEBHOOK_RESP_BODY_CAP, WEBHOOK_RESP_HEADER_ALLOWLIST, type WebhookDelivery } from "./webhooks.js";
import { SoloistRelay } from "./relay.js";
import { AppControl, appControlAllowed, sessionFingerprint, DEBUG_STREAMS, BUFFER_DROP_BYTES, BUFFER_CLOSE_BYTES, APP_CONTROL_PATH, APP_CONTROL_MAX_PAYLOAD } from "./appcontrol.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { loadConfig, saveConfig, ensureSecrets, ConfigError, coerceBool, coerceInt, coerceFloat, maskConfig, configSummary, applyApiConfig, defaultConfig, soloistReady, hashPassword, verifyPassword, isPasswordHashed, DEFAULT_OVERLAY, type Config } from "./config.js";
import { signSession, verifySession, parseCookies, sessionUser, webConfigured, relayView, overlayBootstrap, handleWebRequest, SESSION_COOKIE } from "./web.js";
import { buildArgv, supervise, SoloistControl, Aborted, setPipewireDeviceOverride, setDockerMode, isDockerMode } from "./supervisor.js";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  parseSinks,
  parseMonitorTargets,
  desiredTargets,
  desiredDelays,
  buildDelayTokens,
  generateFilterChainConf,
  pipewireSinksResponse,
  reconcileOutputs,
  SNAPCAST_KEY,
  DELAY_PREFIX,
  getSinkCache,
  type Runner,
  type Spawner,
} from "./pipewire.js";

// Overlay engine lives in src/web/ (browser ESM, copied to dist/web/). Computed
// specifier so tsc treats it as `any` — it ships no .d.ts.
const engine = await import(new URL("./web/overlay.js", import.meta.url).href);
const { parseLRC, currentIndex } = engine as {
  parseLRC(text: string): { time: number; text: string }[];
  currentIndex(lines: { time: number }[], t: number): number;
};

// Wire-format decoders (ADR-0014 seam): framework-free, shared by the vanilla overlay
// and — as lib/wire.ts — the Vue app. Imported headless here, same browser-ESM pattern.
const landing = await import(new URL("./web/frame.js", import.meta.url).href);
const { fmtTime, readTrack, readPlayback, readQueue } = landing as {
  fmtTime(ms: number): string;
  readTrack(msg: any): { title: string; artist: string; album: string; durationMs: number; art: string } | null;
  readPlayback(msg: any): { positionMs: number | null; timestampMs: number | null; speed: number | null; playing?: boolean; volume: number | null };
  readQueue(msg: any): { title: string; artist: string; album: string; durationMs: number; art: string }[] | null;
};

// Escape-safe JSON highlighter (ADR-0016). Unlike the ./web/*.js imports above (prebuilt
// browser JS copied into dist/), this reaches into the raw Vue-app .ts source, which
// tsc excludes from dist/ — Node's on-the-fly type-stripping runs it at runtime. That way
// the selftest exercises the exact helper the Debug chunk ships, not a re-implementation.
// Computed specifier so tsc leaves the import as `any` rather than trying to resolve it.
const hl = await import(new URL("../src/web-vue/lib/highlight.ts", import.meta.url).href);
const { highlightJson } = hl as { highlightJson(src: string): Promise<string> };

function req(headers: Record<string, string>, url = "/"): IncomingMessage {
  return { headers, url, socket: { remoteAddress: "test" } } as unknown as IncomingMessage;
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${(e as Error).stack ?? (e as Error).message}`); }
}

// Asserts none of `secrets` appears in the serialized form of `obj` — the recurring
// "a view/mask/bootstrap must never leak a secret value" invariant, stated once.
function assertNoLeak(label: string, obj: unknown, secrets: string[]): void {
  const j = typeof obj === "string" ? obj : JSON.stringify(obj);
  for (const s of secrets) assert.ok(!j.includes(s), `${label} leaked ${s}`);
}


await test("detectArch", async () => {
assert.equal(detectArch("x64"), "x86_64");
assert.equal(detectArch("arm64"), "arm64");
assert.equal(detectArch("arm"), "arm32");
assert.throws(() => detectArch("sparc"), AcquisitionError);
assert.equal(tarballUrl("arm64", "https://x/y/"), "https://x/y/soloist_release_arm64.tar.gz");
});


const CT = "s3cret";
const RT = "readonly-tok";
const AUTH_SECRET = "authsess";
const authCfg = (token: string, readonlyToken = "", web = { username: "", password: "", sessionSecret: AUTH_SECRET }): Config =>
  ({ proxy: { token, readonlyToken }, web }) as unknown as Config;
await test("checkAuth token/tier resolution", async () => {
  for (const [hdr, url, cfg, want, msg] of [
    [{ authorization: `Bearer ${CT}` }, "/", authCfg(CT, RT), "control", "auth token -> control"],
    [{}, `/?token=${CT}`, authCfg(CT, RT), "control", "query auth token -> control"],
    [{ authorization: `Bearer ${RT}` }, "/", authCfg(CT, RT), "readonly", "readonly token -> readonly"],
    [{ authorization: "Bearer nope" }, "/", authCfg(CT, RT), "none", "bad token -> none"],
    [{}, "/", authCfg(CT, RT), "none", "missing token -> none"],
    [{ authorization: "Bearer " + CT + "x" }, "/", authCfg(CT, RT), "none", "wrong length -> none"],
    [{}, "/?token=", authCfg(CT, ""), "none", "empty presented never matches empty readonly"],
    [{}, "/?token=", authCfg("", ""), "none", "setup mode: empty proxy.token never grants control"],
  ] as const) {
    assert.equal(checkAuth(req(hdr, url), cfg), want, msg);
  }
  // Web-session cookie path (different shape) kept explicit.
  assert.equal(
    checkAuth(req({ cookie: `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}` }), authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET })),
    "control",
    "valid web session -> control",
  );
});


// sameOrigin: cookie-authed WS upgrades must be same-origin (CSWSH defense). Token
// clients bypass this; only the tokenless cookie path is gated in proxy's upgrade handler.
await test("sameOrigin CSWSH guard", async () => {
assert.equal(sameOrigin(req({ origin: "http://host:8687", host: "host:8687" })), true, "matching origin/host");
assert.equal(sameOrigin(req({ origin: "http://evil.example", host: "host:8687" })), false, "cross-origin rejected");
assert.equal(sameOrigin(req({ host: "host:8687" })), false, "missing Origin rejected (browsers always send it)");
assert.equal(sameOrigin(req({ origin: "http://host:8687" })), false, "missing Host rejected");
assert.equal(sameOrigin(req({ origin: "::not a url::", host: "host:8687" })), false, "unparseable Origin rejected");
// Normalized: hostname case-folded, and default ports (none/80/443) treated as equal — so
// a TLS-terminated https Origin still matches the plain Host we were reached on (host-only,
// no scheme compare). A different explicit port still fails.
assert.equal(sameOrigin(req({ origin: "http://HOST:8687", host: "host:8687" })), true, "hostname case-insensitive");
assert.equal(sameOrigin(req({ origin: "https://host", host: "host:443" })), true, "default ports equivalent (https origin / :443 host)");
assert.equal(sameOrigin(req({ origin: "https://host:8687", host: "host:8687" })), true, "scheme mismatch is not a rejection (host-only)");
assert.equal(sameOrigin(req({ origin: "http://host:9999", host: "host:8687" })), false, "explicit port mismatch rejected");
});


const buf = (s: string): RawData => Buffer.from(s) as unknown as RawData;
await test("decodeFrame", async () => {
assert.deepEqual(decodeFrame(buf('{"type":"auth_state","logged_in":true}'), false), {
  type: "auth_state",
  message: { type: "auth_state", logged_in: true },
  raw: '{"type":"auth_state","logged_in":true}',
});
assert.equal(decodeFrame(buf("{"), false), null, "malformed JSON skipped");
assert.equal(decodeFrame(buf('{"no":"type"}'), false), null, "type-less frame skipped");
assert.equal(decodeFrame(buf('"a string"'), false), null, "non-object JSON skipped");
assert.equal(decodeFrame(buf('{"type":"x"}'), true), null, "binary frame skipped");
});


await test("coerceBool", async () => {
assert.equal(coerceBool("true", false), true);
assert.equal(coerceBool("NO", true), false);
assert.equal(coerceBool("1", false), true);
assert.equal(coerceBool("", true), true, "empty falls back to default");
assert.equal(coerceBool(undefined, false), false, "unset falls back to default");
assert.equal(coerceBool("garbage", true), true, "unrecognized falls back to default");
assert.equal(coerceInt("42", 0), 42);
assert.equal(coerceInt("", 5), 5, "empty falls back to default");
assert.equal(coerceInt("nope", 7), 7, "non-numeric falls back to default");
assert.equal(coerceFloat("0.35", 1), 0.35, "parses a fractional value");
assert.equal(coerceFloat("", 0.5), 0.5, "empty falls back to default");
assert.equal(coerceFloat(undefined, 0.5), 0.5, "unset falls back to default");
assert.equal(coerceFloat("nope", 0.25), 0.25, "non-numeric falls back to default");
});


// safeStrEqual: constant-time compare, length-guarded so timingSafeEqual never throws.
await test("safeStrEqual constant-time compare", async () => {
assert.equal(safeStrEqual("abc", "abc"), true, "equal strings match");
assert.equal(safeStrEqual("abc", "abd"), false, "same-length mismatch rejected");
assert.equal(safeStrEqual("abc", "abcd"), false, "different lengths rejected without throwing");
assert.equal(safeStrEqual("", ""), true, "empty equals empty");
});


// backoffStep: crash-loop backoff doubles up to the cap, resets after a healthy run.
await test("backoffStep crash-loop backoff", async () => {
assert.deepEqual(backoffStep(BACKOFF_BASE, 0), { sleep: BACKOFF_BASE, next: BACKOFF_BASE * 2 }, "quick crash sleeps current, doubles next");
assert.deepEqual(backoffStep(BACKOFF_MAX, 0), { sleep: BACKOFF_MAX, next: BACKOFF_MAX }, "doubling is capped at BACKOFF_MAX");
assert.deepEqual(backoffStep(BACKOFF_MAX, 999), { sleep: BACKOFF_BASE, next: BACKOFF_BASE * 2 }, "a run past HEALTHY_SECONDS resets to base");
});


// listenParts (item C): split at the LAST colon (IPv6-safe), error clearly on garbage
// rather than silently producing NaN.
await test("listenParts host:port split", async () => {
assert.deepEqual(listenParts("0.0.0.0:8687"), { host: "0.0.0.0", port: 8687 }, "host:port splits normally");
assert.deepEqual(listenParts(":8687"), { host: "0.0.0.0", port: 8687 }, "no host defaults to 0.0.0.0");
assert.deepEqual(listenParts("[::1]:8687"), { host: "::1", port: 8687 }, "IPv6 literal splits at the port colon and sheds its brackets for server.listen");
assert.throws(() => listenParts("8687"), /invalid proxy.listen/, "no colon: clear error, not NaN");
assert.throws(() => listenParts("host:notaport"), /invalid proxy.listen/, "non-numeric port: clear error");
assert.throws(() => listenParts("host:0"), /invalid proxy.listen/, "port 0: clear error");
});


const frame = (msg: Record<string, unknown>): UpstreamFrame => ({
  type: String(msg.type),
  message: msg,
  raw: JSON.stringify(msg),
});
const loggedIn = frame({ type: "auth_state", logged_in: true });
await test("shouldAutoplay", async () => {
assert.equal(shouldAutoplay({ fired: false }, frame({ type: "auth_state", logged_in: false })), false, "not logged in: no autoplay");
assert.equal(shouldAutoplay({ fired: false }, loggedIn), true, "false->true fires");
assert.equal(shouldAutoplay({ fired: false }, loggedIn), true, "already-true on connect fires");
assert.equal(shouldAutoplay({ fired: true }, loggedIn), false, "once-per-connection guard");
assert.equal(shouldAutoplay({ fired: false }, frame({ type: "playback_state", logged_in: true })), false, "non-auth_state ignored");
});


await test("AUTOPLAY_FRAMES command envelopes", async () => {
assert.deepEqual(
  AUTOPLAY_FRAMES,
  [{ type: "command", command: "activate" }, { type: "command", command: "play" }],
  "autoplay injects Soloist command envelopes (activate then play)",
);
});


const whCfg = { defaultUrl: "http://def", urls: { track_changed: "http://tc", error: "http://err" }, secret: "", delayMs: 0 };
await test("resolveWebhookUrl", async () => {
assert.equal(resolveWebhookUrl("auth_state", whCfg), "http://def", "state event -> default_url");
assert.equal(resolveWebhookUrl("track_changed", whCfg), "http://tc", "override replaces default");
assert.equal(resolveWebhookUrl("error", whCfg), "http://err", "error only with explicit override");
assert.equal(resolveWebhookUrl("command_result", whCfg), null, "command_result without override -> none");
assert.equal(resolveWebhookUrl("auth_state", { defaultUrl: "", urls: {}, secret: "", delayMs: 0 }), null, "no default/override -> none");
});


const fires: number[] = [];
const spaced: (() => void)[] = [];
const q1 = new WebhookQueue(100, { schedule: (fn, ms) => { assert.equal(ms, 100, "throttle spacing == delayMs"); spaced.push(fn); } });
await test("WebhookQueue throttle spacing", async () => {
q1.push(() => fires.push(1));
assert.deepEqual(fires, [1], "first task fires immediately");
q1.push(() => fires.push(2));
q1.push(() => fires.push(3));
assert.deepEqual(fires, [1], "throttle holds queued tasks");
spaced.shift()!();
spaced.shift()!();
assert.deepEqual(fires, [1, 2, 3], "queued tasks drain FIFO");
});


const order: string[] = [];
const drops: number[] = [];
const held: (() => void)[] = [];
const q2 = new WebhookQueue(50, { cap: 3, schedule: (fn) => held.push(fn), onDrop: () => drops.push(1) });
await test("q2", async () => {
for (const c of ["A", "B", "C", "D", "E"]) q2.push(() => order.push(c));
assert.equal(q2.size(), 3, "queue bounded at cap");
assert.equal(drops.length, 1, "one drop at cap");
while (held.length) held.shift()!();
assert.deepEqual(order, ["A", "C", "D", "E"], "oldest queued (B) dropped, rest FIFO");
});


const sync: number[] = [];
const q0 = new WebhookQueue(0, { schedule: () => assert.fail("no timer when delayMs is 0") });
await test("WebhookQueue no timer when delayMs 0", async () => {
q0.push(() => sync.push(1));
q0.push(() => sync.push(2));
assert.deepEqual(sync, [1, 2], "delayMs 0 drains synchronously in order");
});


// A throwing task must not wedge the drain loop (item E).
const seen: number[] = [];
const qThrow = new WebhookQueue(0, { schedule: () => assert.fail("no timer when delayMs is 0") });
await test("WebhookQueue handler error isolation", async () => {
qThrow.push(() => { throw new Error("boom"); });
qThrow.push(() => seen.push(1));
assert.deepEqual(seen, [1], "drain continues past a task that throws");
assert.equal(qThrow.size(), 0, "queue fully drained despite the throw");
});


// WebhookHistory ring buffer + postWebhook capture, redaction, and body cap.
function fakeFetch(status: number, headers: Record<string, string>, body: string): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

// a) Capture shape: a successful delivery records type/url/status/timing/body.
await test("postWebhook records delivery capture shape", async () => {
  const h = new WebhookHistory();
  await postWebhook(h, "track_changed", "http://t", "{}", "sek", fakeFetch(200, { "content-type": "application/json" }, "ok"));
  const d = h.last();
  assert.ok(d, "delivery recorded");
  assert.equal(d!.type, "track_changed", "type recorded");
  assert.equal(d!.url, "http://t", "url recorded");
  assert.equal(d!.status, 200, "status recorded");
  assert.equal(d!.error, null, "no error on success");
  assert.equal(d!.respBody, "ok", "response body recorded");
  assert.equal(typeof d!.at, "number", "at is a number");
  assert.ok(d!.at > 0, "at is a real timestamp");
  assert.ok(d!.durationMs >= 0, "durationMs recorded");
});

// b) Request redaction: the Authorization header is masked in the recorded delivery,
// and the raw secret never appears anywhere in it.
await test("postWebhook redacts the request secret", async () => {
  const h = new WebhookHistory();
  await postWebhook(h, "track_changed", "http://t", "{}", "supersecret", fakeFetch(200, { "content-type": "application/json" }, "ok"));
  const d = h.last()!;
  assert.equal(d.reqHeaders.authorization, "Bearer ***", "authorization header redacted");
  assert.equal(d.reqHeaders["content-type"], "application/json", "content-type header preserved");
  assertNoLeak("postWebhook delivery", d, ["supersecret"]);
});

// c) Response header allowlist: only allowlisted response headers survive; anything
// else (e.g. vendor/API-key headers) is dropped, never recorded.
await test("postWebhook allowlists response headers", async () => {
  const h = new WebhookHistory();
  await postWebhook(h, "track_changed", "http://t", "{}", "", fakeFetch(200, {
    "content-type": "application/json",
    "date": "Fri, 04 Sep 2026 00:00:00 GMT",
    "x-api-key": "leak",
    "x-vendor-sig": "sig",
  }, "ok"));
  const d = h.last()!;
  assert.ok(d.respHeaders["content-type"], "allowlisted content-type kept");
  assert.ok(d.respHeaders["date"], "allowlisted date kept");
  assert.ok(!("x-api-key" in d.respHeaders), "non-allowlisted x-api-key dropped");
  assert.ok(!("x-vendor-sig" in d.respHeaders), "non-allowlisted x-vendor-sig dropped");
  assertNoLeak("postWebhook respHeaders", d.respHeaders, ["leak", "sig"]);
});

// Response-header allowlist also drops Set-Cookie (a session-fixation vector) and x-api-key:
// neither reaches the recorded delivery a Debug Subscriber later sees (ADR-0016).
await test("postWebhook drops set-cookie and x-api-key response headers", async () => {
  const h = new WebhookHistory();
  await postWebhook(h, "track_changed", "http://t", "{}", "", fakeFetch(200, {
    "content-type": "application/json",
    "set-cookie": "sid=leak; HttpOnly",
    "x-api-key": "leak",
  }, "ok"));
  const d = h.last()!;
  assert.ok(d.respHeaders["content-type"], "allowlisted content-type kept");
  assert.ok(!("set-cookie" in d.respHeaders), "non-allowlisted set-cookie dropped");
  assert.ok(!("x-api-key" in d.respHeaders), "non-allowlisted x-api-key dropped");
  assertNoLeak("postWebhook respHeaders", d.respHeaders, ["leak"]);
});

// d) Streamed body cap + truncation: an oversized body is capped and marked truncated;
// a short body records verbatim with no marker.
await test("postWebhook caps and truncates an oversized streamed body", async () => {
  const h = new WebhookHistory();
  const big = "x".repeat(WEBHOOK_RESP_BODY_CAP + 5000);
  await postWebhook(h, "track_changed", "http://t", "{}", "", fakeFetch(200, {}, big));
  const d = h.last()!;
  assert.ok(d.respBody.includes("…[truncated]"), "truncation marker present");
  const capped = d.respBody.slice(0, WEBHOOK_RESP_BODY_CAP);
  assert.ok(/^x+$/.test(capped) && capped.length === WEBHOOK_RESP_BODY_CAP, "body content capped at WEBHOOK_RESP_BODY_CAP");
  assert.equal(d.respBody.length, WEBHOOK_RESP_BODY_CAP + "…[truncated]".length, "total length is cap + marker length");
});

await test("postWebhook records a short body verbatim, no marker", async () => {
  const h = new WebhookHistory();
  await postWebhook(h, "track_changed", "http://t", "{}", "", fakeFetch(200, {}, "short body"));
  const d = h.last()!;
  assert.equal(d.respBody, "short body", "short body recorded verbatim");
  assert.ok(!d.respBody.includes("…[truncated]"), "no truncation marker for a short body");
});

await test("postWebhook does not mark a body sized exactly to the cap as truncated", async () => {
  const h = new WebhookHistory();
  const exact = "x".repeat(WEBHOOK_RESP_BODY_CAP);
  await postWebhook(h, "track_changed", "http://t", "{}", "", fakeFetch(200, {}, exact));
  const d = h.last()!;
  assert.equal(d.respBody, exact, "body exactly at the cap recorded verbatim");
  assert.ok(!d.respBody.includes("…[truncated]"), "no marker when body length equals the cap");
});

// e) onEntry disposer is idempotent: calling it twice must not throw, and must not
// affect other still-registered listeners.
await test("WebhookHistory onEntry disposer is idempotent", async () => {
  const h = new WebhookHistory();
  let n = 0;
  let m = 0;
  const off = h.onEntry(() => n++);
  h.onEntry(() => m++);
  const mkDelivery = (i: number): WebhookDelivery =>
    ({ at: i, type: "t", url: "u" + i, status: 200, durationMs: 0, reqHeaders: {}, respHeaders: {}, respBody: "", error: null });

  h.record(mkDelivery(0));
  assert.equal(n, 1, "listener fires on first record");
  off();
  h.record(mkDelivery(1));
  assert.equal(n, 1, "disposed listener does not fire again");
  assert.doesNotThrow(() => off(), "calling the disposer a second time does not throw");
  h.record(mkDelivery(2));
  assert.equal(n, 1, "still disposed after a second off() call");
  assert.equal(m, 3, "the other, still-registered listener keeps firing after the first is disposed");
});

// f) Ring eviction at 10: the buffer caps at WEBHOOK_HISTORY_CAP, oldest-first.
await test("WebhookHistory evicts oldest entries at cap 10", async () => {
  const h = new WebhookHistory();
  for (let i = 0; i < 12; i++) {
    h.record({ at: i, type: "t", url: "u" + i, status: 200, durationMs: 0, reqHeaders: {}, respHeaders: {}, respBody: "", error: null });
  }
  const entries = h.entries();
  assert.equal(entries.length, 10, "ring buffer capped at 10");
  assert.equal(entries[0].url, "u2", "oldest surviving entry is the 3rd recorded");
  assert.equal(h.last()!.url, "u11", "last() returns the most recent entry");
});


// relayView: reports url + auth presence + live status, never the Authorization value.
const relayCfg = { relay: { url: "wss://relay.example/x", authorization: "Bearer topsecret" } } as unknown as Config;
const rStatus = { enabled: true, connected: true, lastConnectAt: 123, lastError: null };
const rView = relayView(relayCfg, rStatus) as { config: { url: string; hasAuth: boolean }; status: typeof rStatus };
await test("relayView hides auth", async () => {
assert.equal(rView.config.url, "wss://relay.example/x", "relay url reported");
assert.equal(rView.config.hasAuth, true, "auth presence exposed as boolean");
assertNoLeak("relayView", rView, ["topsecret"]);
assert.deepEqual(rView.status, rStatus, "live status passed through");
});

const rViewOff = relayView({ relay: { url: "", authorization: "" } } as unknown as Config) as { config: { hasAuth: boolean }; status: { enabled: boolean } };
await test("relayView disabled", async () => {
assert.equal(rViewOff.config.hasAuth, false, "empty auth -> hasAuth false");
assert.equal(rViewOff.status.enabled, false, "no url + no status -> disabled");
});


// Lyrics Overlay engine: parseLRC + currentIndex (folded in from the prototype).
await test("Lyrics overlay parseLRC + currentIndex", async () => {
  const lrc = ["[ar:The Weeknd]", "[00:12.50]First line", "[00:15.00]Second line", "[00:15.00]Same time echo", "not a timed line", "[01:03.20]Later"].join("\n");
  const lines = parseLRC(lrc);
  assert.deepEqual(lines.map((l) => l.time), [12.5, 15, 15, 63.2], "parseLRC extracts sorted numeric timestamps, drops metadata + untimed");
  assert.equal(lines[0].text, "First line", "parseLRC strips the timestamp tag");
  assert.deepEqual(parseLRC("[00:05.00][00:20.00]Chorus").map((l) => l.time), [5, 20], "multi-timestamp line splits into one entry each");
  assert.equal(parseLRC("").length, 0, "empty text -> no lines");

  assert.equal(currentIndex(lines, 0), -1, "before the first line: no active index");
  assert.equal(currentIndex(lines, 12.5), 0, "exact timestamp is active");
  assert.equal(currentIndex(lines, 14), 0, "holds a line until the next fires");
  assert.equal(currentIndex(lines, 15), 2, "ties resolve to the last matching line");
  assert.equal(currentIndex(lines, 999), 3, "past the last line stays on it");
  assert.equal(currentIndex([], 10), -1, "no lines -> -1");
});


// Overlay bootstrap: embeds only the Read-only Token + Overlay Config subset,
// never other secrets, and escapes `<` so it can't break out of <script>.
await test("overlayBootstrap token + overlay only", async () => {
  const ovCfg = {
    proxy: { token: "CONTROL-SECRET", readonlyToken: "RO-TOKEN", listen: "x" },
    soloist: { apiKey: "SPOTIFY-KEY" },
    web: { password: "webpass", sessionSecret: "sess" },
    webhooks: { secret: "whsecret" },
    overlay: { ...DEFAULT_OVERLAY, effect: "</script><x>" },
  } as unknown as Config;
  const boot = overlayBootstrap(ovCfg);
  assert.match(boot, /RO-TOKEN/, "read-only token embedded");
  assertNoLeak("overlayBootstrap", boot, ["CONTROL-SECRET", "SPOTIFY-KEY", "webpass", "sess", "whsecret"]);
  assert.equal(boot.indexOf("</script>"), boot.lastIndexOf("</script>"), "only the wrapper's closing tag — no </script> breakout from config");
  assert.match(boot, /\\u003c\/script>/, "`<` in overlay config escaped");
});


const dir = mkdtempSync(join(tmpdir(), "cfgtest-"));
const cfgPath = join(dir, "config.yaml");
// Values are literal now — no ${VAR} interpolation, no env reads.
writeFileSync(
  cfgPath,
  [
    "# hand-written comment that must survive a save",
    "soloist:",
    '  device_name: "Party Speaker"  # inline note',
    '  api_key: "key123"',
    "  extra_args: []",
    "proxy:",
    '  token: "tok123"',
    "  listen: 127.0.0.1:9000",
  ].join("\n"),
);

const cfg = loadConfig(cfgPath);
await test("cfg", async () => {
assert.equal(cfg.soloist.deviceName, "Party Speaker", "literal device_name, no interpolation");
assert.equal(cfg.soloist.apiKey, "key123", "literal value, no env");
assert.equal(cfg.proxy.token, "tok123");
assert.equal(cfg.proxy.listen, "127.0.0.1:9000");
assert.equal(cfg.autoplay, false, "autoplay defaults off when absent");
assert.equal(cfg.webhooks.defaultUrl, "", "webhooks absent -> empty default_url");
assert.deepEqual(cfg.webhooks.urls, {}, "webhooks absent -> no urls");
assert.equal(cfg.webhooks.delayMs, 0, "delay_ms default 0");
});


// New config sections default sanely when absent.
await test("New config sections default sanely when absent", async () => {
assert.equal(cfg.proxy.readonlyToken, "", "readonly_token absent -> empty");
assert.equal(cfg.web.username, "", "web.username absent -> empty");
assert.equal(cfg.web.sessionSecret, "", "web.session_secret absent -> empty");
assert.deepEqual(cfg.audio.outputs, [], "audio.outputs absent -> []");
assert.equal(cfg.audio.snapcast, true, "audio.snapcast defaults on");
assert.deepEqual(cfg.audio.outputDelays, {}, "audio.output_delays absent -> {}");
assert.equal(cfg.relay.url, "", "relay.url absent -> empty (off)");
assert.equal(cfg.relay.authorization, "", "relay.authorization absent -> empty");
assert.deepEqual(cfg.overlay, DEFAULT_OVERLAY, "overlay absent -> defaults");
});


// `${VAR}` is no longer special — it is stored and returned verbatim.
const litPath = join(dir, "literal.yaml");
await test("loadConfig", async () => {
writeFileSync(litPath, ['soloist:', '  device_name: "d"', '  api_key: "${API}"', "  extra_args: []", "proxy:", '  token: "t"'].join("\n"));
assert.equal(loadConfig(litPath).soloist.apiKey, "${API}", "no interpolation: ${VAR} kept literal");
});


await test("loadConfig", async () => {
assert.throws(() => loadConfig(join(dir, "nope.yaml")), ConfigError, "missing file fails fast");
});


// saveConfig round-trips preserving comments and writes the new value.
cfg.soloist.deviceName = "Renamed Speaker";
cfg.audio.outputs = ["alsa_output.hw_0"];
cfg.audio.outputDelays = { "alsa_output.hw_0": 250, over_range: 9999 };
cfg.overlay.fontSize = 72;
saveConfig(cfgPath, cfg);
const savedText = readFileSync(cfgPath, "utf8");
await test("saveConfig preserves file comments", async () => {
assert.match(savedText, /hand-written comment that must survive/, "block comment preserved");
assert.match(savedText, /inline note/, "inline comment preserved");
});

const reloaded = loadConfig(cfgPath);
await test("reloaded", async () => {
assert.equal(reloaded.soloist.deviceName, "Renamed Speaker", "changed value persisted");
assert.deepEqual(reloaded.audio.outputs, ["alsa_output.hw_0"], "list persisted");
assert.equal(reloaded.audio.outputDelays["alsa_output.hw_0"], 250, "output_delays round-trips through save/load");
assert.equal(reloaded.audio.outputDelays.over_range, 5000, "output_delays clamped to 5000ms max on load");
assert.equal(reloaded.overlay.fontSize, 72, "overlay value persisted");
});


// Atomic write leaves no temp file behind.
await test("Atomic write leaves no temp file behind", async () => {
assert.deepEqual(
  readdirSync(dir).filter((f) => f.includes(".tmp-")),
  [],
  "no temp file left after save",
);
});


// saveConfig never persists an invalid config. (Empty creds are valid now — setup
// mode — so use a genuinely malformed field: extra_args must be a list.)
const before = readFileSync(cfgPath, "utf8");
const bad = loadConfig(cfgPath);
await test("saveConfig", async () => {
(bad.soloist as { extraArgs: unknown }).extraArgs = "not-a-list";
assert.throws(() => saveConfig(cfgPath, bad), ConfigError, "invalid config rejected");
assert.equal(readFileSync(cfgPath, "utf8"), before, "file untouched after rejected save");
});


// ensureSecrets mints and persists absent secrets, then is idempotent.
const secretsCfg = loadConfig(cfgPath);
await test("secretsCfg", async () => {
assert.equal(secretsCfg.web.sessionSecret, "", "precondition: no session_secret");
assert.equal(ensureSecrets(cfgPath, secretsCfg), true, "first boot writes secrets");
assert.notEqual(secretsCfg.web.sessionSecret, "", "session_secret generated");
assert.notEqual(secretsCfg.proxy.readonlyToken, "", "readonly_token generated");
});

const persisted = loadConfig(cfgPath);
await test("persisted", async () => {
assert.equal(persisted.web.sessionSecret, secretsCfg.web.sessionSecret, "session_secret persisted");
assert.equal(persisted.proxy.readonlyToken, secretsCfg.proxy.readonlyToken, "readonly_token persisted");
assert.equal(ensureSecrets(cfgPath, persisted), false, "already-set secrets: no rewrite");
});


// Fresh install (no config file): ensureSecrets mints proxy.token too, so control-tier
// token auth works out of the box after setup.
const freshPath = join(dir, "fresh.yaml");
const fresh = defaultConfig();
await test("fresh", async () => {
assert.equal(fresh.proxy.token, "", "precondition: default config has no proxy.token");
assert.equal(ensureSecrets(freshPath, fresh), true, "fresh config: secrets minted");
assert.notEqual(fresh.proxy.token, "", "proxy.token minted");
assert.notEqual(fresh.web.sessionSecret, "", "session_secret minted");
assert.equal(loadConfig(freshPath).proxy.token, fresh.proxy.token, "proxy.token persisted");
});


// Config API: GET masks secrets, config-summary never leaks, PUT round-trips.
const sCfg = loadConfig(cfgPath);
sCfg.soloist.apiKey = "SECRET_API";
sCfg.proxy.token = "SECRET_TOK";
sCfg.proxy.readonlyToken = "SECRET_RO";
sCfg.webhooks.secret = "SECRET_WH";
sCfg.relay.authorization = "SECRET_RELAY";
sCfg.web.password = "SECRET_PW";
sCfg.web.sessionSecret = "SECRET_SESS";
const SECRETS = ["SECRET_API", "SECRET_TOK", "SECRET_RO", "SECRET_WH", "SECRET_RELAY", "SECRET_PW", "SECRET_SESS"];

const masked = maskConfig(sCfg) as any;
await test("maskConfig masks secrets", async () => {
assertNoLeak("maskConfig", masked, SECRETS);
assert.equal(masked.soloist.apiKey, true, "set secret masks to true");
assert.equal(masked.proxy.readonlyToken, true, "set secret masks to true");
assert.equal(masked.soloist.deviceName, sCfg.soloist.deviceName, "non-secret preserved in mask");
});


const summary = configSummary(sCfg) as any;
await test("configSummary flags secrets", async () => {
assertNoLeak("configSummary", summary, SECRETS);
assert.equal(summary.secrets.apiKey, true, "summary flags set secret");
assert.equal(summary.deviceName, sCfg.soloist.deviceName, "summary reports device name");
assert.equal(summary.soloistWs, sCfg.soloistWs, "summary reports soloist_ws");
assert.equal(summary.wsUrl, `ws://${sCfg.soloistWs}`, "summary reports WS URL");
assert.equal((configSummary(loadConfig(cfgPath)) as any).secrets.webPassword, false, "unset secret flags false");
});


const applied = applyApiConfig(sCfg, {
  autoplay: true,
  proxy: { token: true, readonlyToken: "NEW_RO", listen: "9.9.9.9:1" },
  soloist: { apiKey: true, deviceName: "Renamed", dataDir: "/hacked" },
  web: { password: false, sessionSecret: "" },
});
await test("applied", async () => {
assert.equal(applied.proxy.token, "SECRET_TOK", "masked-true secret keeps stored value");
assert.equal(applied.proxy.readonlyToken, "NEW_RO", "fresh string secret updates");
assert.equal(applied.soloist.apiKey, "SECRET_API", "masked-true apiKey keeps stored value");
assert.equal(applied.web.password, "SECRET_PW", "masked-false secret keeps stored value");
assert.equal(applied.web.sessionSecret, "SECRET_SESS", "empty-string secret keeps stored value");
assert.equal(applied.autoplay, true, "hot field applies");
assert.equal(applied.soloist.deviceName, "Renamed", "editable field applies");
assert.equal(applied.proxy.listen, sCfg.proxy.listen, "locked proxy.listen unchanged");
assert.equal(applied.soloist.dataDir, sCfg.soloist.dataDir, "locked data_dir unchanged");
assert.throws(() => applyApiConfig(sCfg, "nope"), ConfigError, "non-object body rejected");
assert.throws(() => applyApiConfig(sCfg, { webhooks: { urls: "nope" } }), ConfigError, "invalid result rejected");
});


// Prototype pollution (item 1 fix): a PUT body's "__proto__"/"constructor" keys must
// never reach Object.prototype via deepMerge.
await test("Prototype pollution (item 1 fix): a PUT body's \"__proto__\"/\"cons...", async () => {
  const evil = JSON.parse('{"autoplay":true,"__proto__":{"polluted":"yes"},"soloist":{"__proto__":{"polluted":"yes"}}}');
  applyApiConfig(sCfg, evil);
  assert.equal(({} as any).polluted, undefined, "Object.prototype not polluted by top-level __proto__");
  assert.equal((sCfg as any).polluted, undefined, "target itself not polluted");
});


// webhooks.urls is a full-replace map: a dropped URL disappears (not merged).
const whCfgBase = loadConfig(cfgPath);
whCfgBase.webhooks.urls = { track_changed: "http://a", error: "http://b" };
const whApplied = applyApiConfig(whCfgBase, { webhooks: { urls: { track_changed: "http://a" } } });
await test("whApplied", async () => {
assert.deepEqual(whApplied.webhooks.urls, { track_changed: "http://a" }, "removed webhook URL dropped from config");
// ...and the removal persists through saveConfig (mergeInto alone would keep it).
saveConfig(cfgPath, whApplied);
assert.deepEqual(loadConfig(cfgPath).webhooks.urls, { track_changed: "http://a" }, "webhook URL removal persisted to file");
});


// Web Session cookie: sign/verify round-trip, tamper rejection, fail-closed, expiry.
const SECRET = "sessionsecret";
const signed = signSession("admin", SECRET);
await test("verifySession", async () => {
assert.equal(verifySession(signed, SECRET), "admin", "cookie round-trips the username");
assert.equal(verifySession(signed, "othersecret"), null, "wrong secret rejected");
// Flip the last MAC char to a guaranteed-different one — a fixed "x" is a no-op when the
// (timestamped, per-run) MAC already ends in "x", which would leave the token untampered.
assert.equal(verifySession(signed.slice(0, -1) + (signed.at(-1) === "a" ? "b" : "a"), SECRET), null, "tampered signature rejected");
});

await test("session tamper rejection", async () => {
  // Forge a payload for a different user; its signature won't match the original MAC.
  const forgedPayload = Buffer.from(`root|${Date.now()}`).toString("base64url");
  const originalMac = signed.slice(signed.lastIndexOf(".") + 1);
  assert.equal(verifySession(`${forgedPayload}.${originalMac}`, SECRET), null, "tampered payload rejected");
});

await test("verifySession", async () => {
assert.equal(verifySession("nodot", SECRET), null, "malformed cookie rejected");
});


// Session never expires (item 2 fix): a cookie older than the max age is rejected
// even with a valid signature.
await test("session expiry rejection", async () => {
  // Mirror web.ts's key derivation (secret + password binding) so we can forge a cookie
  // with a chosen issued-at. Default binding "" matches an unbound signSession/verifySession.
  const mkMac = (payload: string, pw = "") => {
    const key = createHmac("sha256", SECRET).update("pw\0").update(pw).digest();
    return createHmac("sha256", key).update(payload).digest("base64url");
  };
  const oldPayload = Buffer.from(`admin|${Date.now() - 31 * 24 * 60 * 60 * 1000}`).toString("base64url");
  assert.equal(verifySession(`${oldPayload}.${mkMac(oldPayload)}`, SECRET), null, "expired session rejected");
  const freshPayload = Buffer.from(`admin|${Date.now() - 24 * 60 * 60 * 1000}`).toString("base64url");
  assert.equal(verifySession(`${freshPayload}.${mkMac(freshPayload)}`, SECRET), "admin", "1-day-old session still valid");
});


await test("parseCookies", async () => {
assert.deepEqual(parseCookies("a=1; soloist_session=xyz"), { a: "1", soloist_session: "xyz" }, "cookie header parsed");
assert.deepEqual(parseCookies(undefined), {}, "no cookie header -> empty");
});


const webReq = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as IncomingMessage;
const webCfg = (u: string, p: string): Config => ({ web: { username: u, password: p, sessionSecret: SECRET } }) as unknown as Config;

await test("webConfigured", async () => {
assert.equal(webConfigured(webCfg("admin", "pw")), true, "creds set -> configured");
assert.equal(webConfigured(webCfg("", "")), false, "creds unset -> not configured");
assert.equal(webConfigured(webCfg("admin", "")), false, "half-set creds -> not configured");
});


const cfgSet = webCfg("admin", "pw");
await test("sessionUser", async () => {
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", SECRET, "pw")}`), cfgSet), "admin", "valid cookie -> user");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", "wrong", "pw")}`), cfgSet), null, "bad-secret cookie -> null");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("mallory", SECRET, "pw")}`), cfgSet), null, "cookie for other user -> null");
assert.equal(sessionUser(webReq(), cfgSet), null, "no cookie -> null");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", SECRET, "pw")}`), webCfg("", "")), null, "fail-closed: unset creds reject valid cookie");
});


// Rotating the password revokes live sessions: the MAC key folds in the password, so a
// cookie signed under the old password no longer verifies once it changes.
await test("password rotation revokes sessions", async () => {
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", SECRET, "old-pw")}`), webCfg("admin", "new-pw")), null, "password change revokes existing session");
assert.equal(verifySession(signSession("admin", SECRET, "pw-A"), SECRET, "pw-B"), null, "session signed under a different password is rejected");
});


const meta = (over: Partial<import("./proxy.js").ClientMeta> = {}): import("./proxy.js").ClientMeta =>
  ({ id: "id", remoteAddr: "127.0.0.1", tier: "control", auth: "auth-token", connectedAt: 0, userAgent: "ua", ...over });

// Hub read-only drop + state replay, against a real in-process upstream.
await test("Hub read-only drop + state replay, against a real in-process upstream", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  const gotUpstream: string[] = [];
  upstream.on("connection", (ws) => ws.on("message", (d: RawData) => gotUpstream.push(d.toString())));

  const hub = new SoloistHub(`ws://127.0.0.1:${port}`);
  void hub.run();
  const [upstreamConn] = (await once(upstream, "connection")) as [WebSocket];

  upstreamConn.send('{"type":"playback_state","playing":true}');
  await new Promise((r) => setTimeout(r, 50)); // let the frame reach the hub and cache

  const fake = () => ({ readyState: WebSocket.OPEN, sent: [] as unknown[], send(d: unknown) { this.sent.push(d); } });

  const ro = fake();
  hub.register(ro as unknown as WebSocket, meta({ tier: "readonly", auth: "readonly-token" }));
  assert.deepEqual(ro.sent, ['{"type":"playback_state","playing":true}'], "read-only client gets state replay on connect");
  await hub.forward(ro as unknown as WebSocket, Buffer.from('{"type":"command","command":"play"}') as unknown as RawData, false);
  assert.deepEqual(gotUpstream, [], "read-only client frames dropped, never forwarded upstream");

  const ctrl = fake();
  hub.register(ctrl as unknown as WebSocket, meta());
  assert.deepEqual(ctrl.sent, ['{"type":"playback_state","playing":true}'], "control client gets state replay on connect");
  await hub.forward(ctrl as unknown as WebSocket, Buffer.from('{"type":"command","command":"play"}') as unknown as RawData, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(gotUpstream, ['{"type":"command","command":"play"}'], "control client frames forwarded upstream");

  hub.stop();
  upstream.close();
});


// Client metadata enum, clientList shape, and loggedIn() null-while-down.
await test("Hub client metadata + status getters", async () => {
  // auth enum is derived, never the raw token
  const RAWTOK = "CONTROL-SECRET-RAW";
  const cfg = authCfg(RAWTOK, "RO-RAW");
  assert.deepEqual(resolveAuth(req({ authorization: `Bearer ${RAWTOK}` }, "/"), cfg), { tier: "control", auth: "auth-token" }, "control token -> auth-token enum");
  assert.deepEqual(resolveAuth(req({ authorization: `Bearer RO-RAW` }, "/"), cfg), { tier: "readonly", auth: "readonly-token" }, "readonly token -> readonly-token enum");
  assert.deepEqual(resolveAuth(req({}, "/"), cfg), { tier: "none", auth: null }, "no creds -> none/null");
  // session cookie -> session-cookie enum
  const wc = authCfg(RAWTOK, "RO-RAW", { username: "admin", password: "pw", sessionSecret: AUTH_SECRET });
  assert.deepEqual(resolveAuth(req({ cookie: `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}` }, "/"), wc), { tier: "control", auth: "session-cookie" }, "cookie -> session-cookie enum");
  // A bogus token alongside a valid cookie still resolves to session-cookie, so the
  // upgrade handler's same-origin gate (keyed on auth) is not bypassed by a junk token.
  assert.deepEqual(resolveAuth(req({ cookie: `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}` }, "/?token=garbage"), wc), { tier: "control", auth: "session-cookie" }, "bogus token + cookie -> session-cookie (CSWSH gate stays armed)");

  // clientList() shape + loggedIn() null while upstream down (never connected)
  const hub = new SoloistHub("ws://127.0.0.1:1"); // never connects
  assert.equal(hub.upstreamConnected, false, "upstream not connected");
  assert.equal(hub.loggedIn(), null, "loggedIn() is null while upstream is down");
  assert.equal(hub.clientCount(), 0, "no clients yet");
  const fakeWs = { readyState: WebSocket.OPEN, send() {} };
  hub.register(fakeWs as unknown as WebSocket, meta({ id: "c1", remoteAddr: "10.0.0.5", tier: "readonly", auth: "readonly-token", connectedAt: 123, userAgent: "TestUA" }));
  assert.equal(hub.clientCount(), 1, "one client registered");
  const list = hub.clientList();
  assert.equal(list.length, 1, "clientList has one entry");
  assert.deepEqual(list[0], { id: "c1", remoteAddr: "10.0.0.5", tier: "readonly", auth: "readonly-token", connectedAt: 123, userAgent: "TestUA" }, "clientList entry is the full ClientMeta");
  // the raw token never appears in metadata
  assert.ok(!JSON.stringify(list).includes(RAWTOK), "raw token never stored in client metadata");
  hub.stop();
});


// Proxy Status builder: the proxy_status frame carries a compact webhook summary only —
// the last delivery's at/type/status/ok — never its request/response headers or body (that
// full detail rides the separate `webhooks` stream). Also covers the ok classification.
await test("buildProxyStatus emits a compact webhook summary (no headers/body)", async () => {
  const hub = new SoloistHub("ws://127.0.0.1:1"); // never connects: upstream down, loggedIn null
  const history = new WebhookHistory();
  const relay = { enabled: true, connected: false, lastConnectAt: null, lastError: "boom" };
  const control = new SoloistControl();
  control.setState("running");

  // No deliveries yet: webhook summary is null; soloist reflects control + a down upstream.
  const empty = buildProxyStatus(hub, relay, history, control);
  assert.equal(empty.webhook, null, "no webhook history -> null summary");
  assert.deepEqual(empty.soloist, { state: "running", upstream: false, loggedIn: null }, "soloist snapshot");
  assert.equal(empty.clients, 0, "no downstream clients");
  assert.equal(empty.relay, relay, "relay status passed straight through");
  // control absent -> state null rather than throwing.
  assert.equal(buildProxyStatus(hub, relay, history).soloist.state, null, "no control -> state null");

  // A full delivery with secrets in headers + body collapses to the four-field summary.
  const delivery: WebhookDelivery = {
    at: 1000, type: "now_playing", url: "http://hook.example/deliver", status: 200, durationMs: 5,
    reqHeaders: { authorization: "Bearer ***", "x-token": "REQSECRET" },
    respHeaders: { "content-type": "application/json" },
    respBody: "RESPSECRETBODY", error: null,
  };
  history.record(delivery);
  const s = buildProxyStatus(hub, relay, history, control);
  assert.deepEqual(s.webhook, { at: 1000, type: "now_playing", status: 200, ok: true }, "compact 4-field summary");
  assertNoLeak("proxy_status webhook summary", s, ["REQSECRET", "RESPSECRETBODY", "hook.example", "application/json"]);

  // ok is 2xx-with-a-response only: non-2xx and network errors are not ok.
  history.record({ ...delivery, at: 2000, status: 500 });
  assert.equal(buildProxyStatus(hub, relay, history, control).webhook?.ok, false, "5xx -> not ok");
  history.record({ ...delivery, at: 3000, status: null, error: "timeout" });
  assert.deepEqual(buildProxyStatus(hub, relay, history, control).webhook, { at: 3000, type: "now_playing", status: null, ok: false }, "network error -> status null, not ok");
  hub.stop();
});


// App-Control onSubscribe: a producer hook fires once per newly-subscribed stream and seeds
// just that socket; a repeated subscribe re-fires nothing; a hook throw is isolated.
await test("AppControl onSubscribe seeds a new subscriber once", async () => {
  const cfg = authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET });
  const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
  const ac = new AppControl(cfg);
  ac.onSubscribe((stream, send) => {
    if (stream === "frame") throw new Error("boom"); // isolated: must not stop clients being seeded
    send({ snapshot: stream });
  });

  const ls: Record<string, ((...a: any[]) => void)[]> = {};
  const ws = {
    readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [] as string[],
    on(ev: string, fn: (...a: any[]) => void) { (ls[ev] ??= []).push(fn); return this; },
    emit(ev: string, ...a: any[]) { (ls[ev] ?? []).forEach((f) => f(...a)); },
    send(d: string) { this.sent.push(d); }, close() {},
  };
  ac.register(ws as unknown as WebSocket, cookie);

  // Subscribing to two streams seeds each once; the throwing `frame` hook is swallowed.
  ws.emit("message", buf(JSON.stringify({ type: "subscribe", streams: ["frame", "clients"] })), false);
  assert.deepEqual(ws.sent, [JSON.stringify({ stream: "clients", data: { snapshot: "clients" } })], "clients seeded once; frame hook throw isolated");

  // Re-subscribing to an already-subscribed stream re-seeds nothing (idempotent).
  ws.emit("message", buf(JSON.stringify({ type: "subscribe", streams: ["clients"] })), false);
  assert.equal(ws.sent.length, 1, "repeat subscribe re-fires no snapshot");
  ac.stop();
});


// App-Control upgrade gate: a Debug Subscriber upgrade needs a valid Web Session cookie AND
// a same-host Origin. Tokens are not accepted; a host mismatch or missing/malformed Origin is
// rejected; a scheme-only mismatch is NOT a rejection.
await test("appControlAllowed session+same-host gate", async () => {
  const cfg = authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET });
  const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
  assert.equal(appControlAllowed(req({ cookie, origin: "http://host:8687", host: "host:8687" }), cfg), true, "session cookie + same host accepted");
  assert.equal(appControlAllowed(req({ cookie, origin: "https://host:8687", host: "host:8687" }), cfg), true, "scheme mismatch is not a rejection");
  assert.equal(appControlAllowed(req({ authorization: `Bearer ${CT}`, origin: "http://host:8687", host: "host:8687" }), cfg), false, "token-only (no session cookie) rejected");
  assert.equal(appControlAllowed(req({ cookie, origin: "http://evil.example", host: "host:8687" }), cfg), false, "host mismatch rejected");
  assert.equal(appControlAllowed(req({ cookie, host: "host:8687" }), cfg), false, "missing Origin rejected");
  assert.equal(appControlAllowed(req({ cookie, origin: "::bad::", host: "host:8687" }), cfg), false, "malformed Origin rejected");
});


// Debug Subscriber tier: subscribe validation, idempotency, safe handling of bad frames,
// backpressure gating, logout/pw-rotation close, and exclusion from the Client Count.
await test("AppControl Debug Subscriber tier", async () => {
  const webCfg = { username: "admin", password: "pw", sessionSecret: AUTH_SECRET };
  const cfg = authCfg(CT, RT, webCfg);
  const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;

  type FakeWs = {
    readyState: number; bufferedAmount: number; sent: string[]; closed: { code: number; reason: string } | null;
    on(ev: string, fn: (...a: any[]) => void): FakeWs; emit(ev: string, ...a: any[]): void;
    send(d: string): void; close(code: number, reason: string): void;
  };
  const fakeWs = (): FakeWs => {
    const ls: Record<string, ((...a: any[]) => void)[]> = {};
    return {
      readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], closed: null,
      on(ev, fn) { (ls[ev] ??= []).push(fn); return this; },
      emit(ev, ...a) { (ls[ev] ?? []).forEach((f) => f(...a)); },
      send(d) { this.sent.push(d); },
      close(code, reason) { this.closed = { code, reason }; this.readyState = WebSocket.CLOSED; },
    };
  };

  const ac = new AppControl(cfg);

  // subscribe validates against the fixed set; unknown streams ignored; idempotent.
  const a = fakeWs();
  ac.register(a as unknown as WebSocket, cookie);
  assert.equal(ac.count(), 1, "one debug subscriber registered");
  a.emit("message", buf(JSON.stringify({ type: "subscribe", streams: ["frame", "nope", "clients"] })), false);
  a.emit("message", buf(JSON.stringify({ type: "subscribe", streams: ["frame"] })), false); // repeat -> no duplicate
  ac.publish("frame", { n: 1 });
  assert.deepEqual(a.sent, [JSON.stringify({ stream: "frame", data: { n: 1 } })], "frame delivered once (idempotent subscribe, no duplicate send)");
  ac.publish("proxy_status", { up: true });
  assert.equal(a.sent.length, 1, "not delivered a stream it never subscribed to");

  // malformed / binary / non-subscribe frames are handled safely (no throw, no effect).
  a.emit("message", buf("not json"), false);
  a.emit("message", buf(JSON.stringify({ type: "subscribe", streams: ["proxy_status"] })), true); // binary -> ignored
  a.emit("message", buf(JSON.stringify({ type: "command", command: "play" })), false); // never a control verb here
  ac.publish("proxy_status", { up: true });
  assert.equal(a.sent.length, 1, "binary subscribe ignored; malformed/command frames inert");

  // backpressure: past the drop threshold a `frame` update is shed, but other streams flow;
  // past the hard threshold the socket is closed.
  a.bufferedAmount = BUFFER_DROP_BYTES + 1;
  a.emit("message", buf(JSON.stringify({ type: "subscribe", streams: ["clients"] })), false);
  ac.publish("frame", { n: 2 });
  assert.equal(a.sent.length, 1, "frame update dropped under buffer pressure");
  ac.publish("clients", []);
  assert.equal(a.sent.length, 2, "non-frame stream still flows under drop threshold");
  a.bufferedAmount = BUFFER_CLOSE_BYTES + 1;
  ac.publish("frame", { n: 3 });
  assert.deepEqual(a.closed, { code: 1013, reason: "slow consumer" }, "hopeless slow consumer closed");
  assert.equal(ac.count(), 0, "closed subscriber removed");

  // Client Count exclusion: a Debug Subscriber never lands on the Hub.
  const hub = new SoloistHub("ws://127.0.0.1:1");
  const b = fakeWs();
  ac.register(b as unknown as WebSocket, cookie);
  assert.equal(ac.count(), 1, "debug subscriber counted by AppControl");
  assert.equal(hub.clientCount(), 0, "debug subscriber excluded from the Client Count");
  hub.stop();

  // logout closes every socket whose session fingerprint matches this request's cookie.
  ac.closeForRequest(req({ cookie }));
  assert.deepEqual(b.closed, { code: 1008, reason: "logged out" }, "logout closed the matching subscriber");
  assert.equal(ac.count(), 0, "logged-out subscriber removed");

  // periodic re-check closes a socket whose session no longer verifies (password rotation).
  const c = fakeWs();
  ac.register(c as unknown as WebSocket, cookie);
  ac.recheck();
  assert.equal(c.closed === null, true, "valid session survives re-check");
  webCfg.password = "rotated"; // rotate the password -> every live session is revoked
  ac.recheck();
  assert.equal(c.closed?.code, 1008, "re-check closes a session revoked by password rotation");

  await ac.stop();
});


// A registration with no session cookie is refused outright (defence in depth: the upgrade
// gate already requires one, but register never trusts a cookieless socket).
await test("AppControl refuses a cookieless registration", async () => {
  const cfg = authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET });
  const ac = new AppControl(cfg);
  let closed: number | null = null;
  const ws = { readyState: WebSocket.OPEN, on() { return this; }, close(code: number) { closed = code; } };
  ac.register(ws as unknown as WebSocket, "");
  assert.equal(ac.count(), 0, "no subscriber registered without a session cookie");
  assert.equal(closed, 1008, "cookieless socket closed 1008");
  assert.equal(sessionFingerprint(""), null, "empty cookie has no fingerprint");
  assert.equal(DEBUG_STREAMS.includes("frame"), true, "fixed stream set includes frame");
  await ac.stop();
});


// End-to-end over a real socket: the actual upgrade + subscribe + publish round-trip works,
// and an oversized frame is closed safely by the server's maxPayload (not just by the fake
// harness). Exercises the real ws frame parser the unit tests bypass.
await test("AppControl real-socket round-trip + oversized frame closed safely", async () => {
  const cfg = authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET });
  const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
  const ac = new AppControl(cfg);
  const server = createServer();
  server.on("upgrade", (r, socket, head) => {
    if (appControlAllowed(r, cfg)) ac.handleUpgrade(r, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const client = new WebSocket(`ws://127.0.0.1:${port}${APP_CONTROL_PATH}`, {
    headers: { cookie, origin: `http://127.0.0.1:${port}` },
  });
  await once(client, "open");
  for (let i = 0; i < 100 && ac.count() === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ac.count(), 1, "real upgrade registered a debug subscriber");

  // subscribe + publish round-trip over the wire
  client.send(JSON.stringify({ type: "subscribe", streams: ["proxy_status"] }));
  await new Promise((r) => setTimeout(r, 30)); // let the server process the subscribe
  const gotMsg = once(client, "message");
  ac.publish("proxy_status", { ok: true });
  const [data] = (await gotMsg) as [RawData];
  assert.deepEqual(JSON.parse(data.toString()), { stream: "proxy_status", data: { ok: true } }, "published frame arrives over the real socket");

  // oversized frame: server enforces maxPayload and closes without crashing
  const closed = once(client, "close");
  client.send("x".repeat(APP_CONTROL_MAX_PAYLOAD + 100));
  const [code] = (await closed) as [number];
  assert.equal(code, 1009, "oversized frame closed with 1009 (message too big)");
  for (let i = 0; i < 100 && ac.count() !== 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ac.count(), 0, "subscriber removed after the oversized-frame close");

  await ac.stop();
  server.close();
});


// close() lifecycle (unit): stop() clears the re-check interval, terminates every Debug
// Subscriber socket, and resolves only once the WebSocketServer has finished closing.
await test("AppControl.stop() clears the interval, terminates subscribers, and awaits server close", async () => {
  const cfg = authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET });
  const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
  const ac = new AppControl(cfg);
  let closed: { code: number; reason: string } | null = null;
  const ws = {
    readyState: WebSocket.OPEN,
    on() { return this; },
    close(code: number, reason: string) { closed = { code, reason }; },
  };
  ac.register(ws as unknown as WebSocket, cookie); // registering a subscriber arms the re-check interval
  assert.equal(ac.count(), 1, "subscriber registered");
  await ac.stop();
  assert.deepEqual(closed, { code: 1001, reason: "shutting down" }, "subscriber socket terminated on stop");
  assert.equal(ac.count(), 0, "no subscribers after stop");
  await ac.stop(); // idempotent: a second stop (interval already cleared, no subscribers) still resolves
});


// close() lifecycle (integration): a live Debug Subscriber socket is torn down, the listener
// stops accepting connections, and the returned Promise resolves once shutdown completes.
await test("RunningProxy.close() tears down debug sockets and the App-Control server", async () => {
  const prevDocker = isDockerMode();
  setDockerMode(false); // no PipeWire fan-out / sink polling under test
  const dir = mkdtempSync(join(tmpdir(), "close-"));
  const cfgPath = join(dir, "config.yaml");
  // listenParts rejects port 0, so claim a free ephemeral port with a throwaway listener.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const cfg = defaultConfig();
  cfg.web.username = "admin";
  cfg.web.password = "pw";
  cfg.web.sessionSecret = AUTH_SECRET;
  cfg.proxy.listen = `127.0.0.1:${port}`;
  cfg.soloistWs = "127.0.0.1:1"; // upstream is unreachable; the Hub retries until close() stops it
  const running = await makeServer(cfg, cfgPath);
  try {
    const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
    const client = new WebSocket(`ws://127.0.0.1:${port}${APP_CONTROL_PATH}`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    await once(client, "open");
    for (let i = 0; i < 100 && running.appControl.count() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(running.appControl.count(), 1, "debug subscriber connected before close");

    const clientClosed = once(client, "close");
    await running.close();
    await clientClosed; // the subscriber socket was terminated by the teardown
    assert.equal(running.appControl.count(), 0, "no debug subscribers after close");

    // the listener is gone: a fresh connection is refused
    const dead = new WebSocket(`ws://127.0.0.1:${port}/`);
    await assert.rejects(once(dead, "open"), "server no longer accepts connections after close");
  } finally {
    setDockerMode(prevDocker);
    rmSync(dir, { recursive: true, force: true });
  }
});


// Integration purity (ADR-0016): a Downstream Client on `/`, a Debug Subscriber on /ws/app, and
// a fake Relay all wired through one real makeServer. A genuine Soloist frame reaches `/` and the
// Relay byte-for-byte, while every diagnostic (proxy_status, frame, clients, webhooks) stays on the
// App-Control socket and never leaks to `/` or the Relay.
await test("integration purity: diagnostics stay on App-Control; genuine frames reach / and Relay verbatim", async () => {
  const prevDocker = isDockerMode();
  setDockerMode(false);
  const dir = mkdtempSync(join(tmpdir(), "purity-"));
  const cfgPath = join(dir, "config.yaml");

  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const relaySrv = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await Promise.all([once(upstream, "listening"), once(relaySrv, "listening")]);
  const upPort = (upstream.address() as { port: number }).port;
  const relayPort = (relaySrv.address() as { port: number }).port;

  const gotRelay: string[] = [];
  // makeServer's Hub/Relay dial these during construction, so capture the connections with
  // listeners armed up front — an `await once(...)` after makeServer would miss the event.
  const upReady = new Promise<WebSocket>((res) => upstream.once("connection", res));
  const relayReady = new Promise<void>((res) => relaySrv.once("connection", () => res()));
  relaySrv.on("connection", (ws) => ws.on("message", (d: RawData) => gotRelay.push(d.toString())));

  let hookHit = false;
  const hookSrv = createServer((_req, res) => { hookHit = true; res.writeHead(200, { "content-type": "text/plain" }).end("ok"); });
  await new Promise<void>((r) => hookSrv.listen(0, "127.0.0.1", () => r()));
  const hookPort = (hookSrv.address() as { port: number }).port;

  // listenParts rejects port 0, so claim a free ephemeral port with a throwaway listener.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const cfg = defaultConfig();
  cfg.web.username = "admin";
  cfg.web.password = "pw";
  cfg.web.sessionSecret = AUTH_SECRET;
  cfg.proxy.token = CT;
  cfg.proxy.listen = `127.0.0.1:${port}`;
  cfg.soloistWs = `127.0.0.1:${upPort}`;
  cfg.relay.url = `ws://127.0.0.1:${relayPort}`;
  cfg.relay.authorization = "";
  cfg.webhooks.defaultUrl = `http://127.0.0.1:${hookPort}/hook`;
  cfg.webhooks.delayMs = 0;

  const running = await makeServer(cfg, cfgPath);
  const upConn = await upReady;
  await relayReady;

  const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
  // Debug Subscriber (App-Control) + Downstream Client (`/`); closed in finally before
  // running.close(), since server.close() blocks on any still-open inbound socket.
  const debug = new WebSocket(`ws://127.0.0.1:${port}${APP_CONTROL_PATH}`, {
    headers: { cookie, origin: `http://127.0.0.1:${port}` },
  });
  const down = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${CT}` } });
  try {
    const debugMsgs: { stream: string; data: unknown }[] = [];
    debug.on("message", (d: RawData) => debugMsgs.push(JSON.parse(d.toString())));
    await once(debug, "open");
    debug.send(JSON.stringify({ type: "subscribe", streams: [...DEBUG_STREAMS] }));
    for (let i = 0; i < 100 && running.appControl.count() === 0; i++) await new Promise((r) => setTimeout(r, 5));

    // Downstream Client on `/` (control tier via token) connected before any frame, so it
    // receives exactly what is broadcast afterwards (no cached-state replay in play).
    const gotDownstream: string[] = [];
    down.on("message", (d: RawData) => gotDownstream.push(d.toString()));
    await once(down, "open");
    for (let i = 0; i < 100 && running.hub.clientCount() === 0; i++) await new Promise((r) => setTimeout(r, 5));

    const streamsSeen = () => new Set(debugMsgs.map((m) => m.stream));
    const liveWebhook = () => debugMsgs.some((m) => m.stream === "webhooks" && !Array.isArray(m.data));
    // The outbound mirror drops frames while the proxy's Relay socket isn't OPEN, so wait for a
    // proxy_status showing the Relay connected before emitting the frame (bounded, like the rest).
    const relayUp = () => debugMsgs.some((m) => m.stream === "proxy_status" && (m.data as { relay?: { connected?: boolean } }).relay?.connected === true);
    for (let i = 0; i < 200 && !relayUp(); i++) await new Promise((r) => setTimeout(r, 10));

    // A genuine Soloist frame: broadcast raw to `/` + Relay, mirrored as a `frame` diagnostic, and
    // (track_changed is a state event with a configured URL) fires a webhook delivery.
    const GENUINE = '{"type":"track_changed","item":{"uri":"spotify:x"}}';
    upConn.send(GENUINE);

    for (let i = 0; i < 300; i++) {
      if (gotDownstream.length && gotRelay.length && DEBUG_STREAMS.every((s) => streamsSeen().has(s)) && liveWebhook()) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.deepEqual(gotDownstream, [GENUINE], "Downstream `/` client receives only the genuine frame, verbatim");
    assert.deepEqual(gotRelay, [GENUINE], "Relay Server receives only the genuine frame, verbatim");
    for (const raw of [...gotDownstream, ...gotRelay]) {
      assert.ok(!("stream" in JSON.parse(raw)), `no diagnostic envelope leaked to / or Relay: ${raw}`);
    }

    for (const s of DEBUG_STREAMS) assert.ok(streamsSeen().has(s), `Debug Subscriber received the ${s} diagnostic`);
    assert.ok(hookHit, "the genuine frame fired the webhook");
    assert.ok(liveWebhook(), "a live webhook delivery reached the App-Control socket");
  } finally {
    debug.terminate();
    down.terminate();
    await running.close();
    upstream.close();
    relaySrv.close();
    hookSrv.close();
    setDockerMode(prevDocker);
    rmSync(dir, { recursive: true, force: true });
  }
});


// Logout revokes the diagnostics channel: a POST /logout closes every App-Control socket opened
// under that session (ADR-0016).
await test("integration: POST /logout closes the session's App-Control socket", async () => {
  const prevDocker = isDockerMode();
  setDockerMode(false);
  const dir = mkdtempSync(join(tmpdir(), "logout-"));
  const cfgPath = join(dir, "config.yaml");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const cfg = defaultConfig();
  cfg.web.username = "admin";
  cfg.web.password = "pw";
  cfg.web.sessionSecret = AUTH_SECRET;
  cfg.proxy.listen = `127.0.0.1:${port}`;
  cfg.soloistWs = "127.0.0.1:1"; // upstream unreachable; irrelevant to this test
  const running = await makeServer(cfg, cfgPath);
  try {
    const cookie = `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET, "pw")}`;
    const client = new WebSocket(`ws://127.0.0.1:${port}${APP_CONTROL_PATH}`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    await once(client, "open");
    for (let i = 0; i < 100 && running.appControl.count() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(running.appControl.count(), 1, "debug subscriber connected");

    const closed = once(client, "close");
    const res = await fetch(`http://127.0.0.1:${port}/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302, "logout redirects to /login");
    const [code] = (await closed) as [number];
    assert.equal(code, 1008, "App-Control socket closed with 1008 (logged out)");
    for (let i = 0; i < 100 && running.appControl.count() !== 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(running.appControl.count(), 0, "no debug subscribers after logout");
  } finally {
    await running.close();
    setDockerMode(prevDocker);
    rmSync(dir, { recursive: true, force: true });
  }
});


// Relay bridge: Soloist frames republished verbatim to the Relay Server; frames from
// the Relay Server forwarded raw into the upstream Soloist socket (full control).
await test("Relay bridge republishes frames", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const relaySrv = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await Promise.all([once(upstream, "listening"), once(relaySrv, "listening")]);
  const upPort = (upstream.address() as { port: number }).port;
  const relayPort = (relaySrv.address() as { port: number }).port;

  const gotUpstream: string[] = [];
  upstream.on("connection", (ws) => ws.on("message", (d: RawData) => gotUpstream.push(d.toString())));
  const gotRelay: string[] = [];
  let relayConn: WebSocket | null = null;
  relaySrv.on("connection", (ws) => { relayConn = ws; ws.on("message", (d: RawData) => gotRelay.push(d.toString())); });

  const hub = new SoloistHub(`ws://127.0.0.1:${upPort}`);
  void hub.run();
  const [upConn] = (await once(upstream, "connection")) as [WebSocket];

  const relayCfg = { relay: { url: `ws://127.0.0.1:${relayPort}`, authorization: "" } } as unknown as Config;
  const relay = new SoloistRelay(hub, relayCfg);
  void relay.run();
  await once(relaySrv, "connection");
  await new Promise((r) => setTimeout(r, 30)); // let the relay socket reach OPEN

  // Outbound: a genuine Soloist frame is mirrored verbatim to the Relay Server.
  upConn.send('{"type":"track_changed","item":{"uri":"x"}}');
  for (let i = 0; i < 100 && !gotRelay.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(gotRelay, ['{"type":"track_changed","item":{"uri":"x"}}'], "Soloist frame republished to Relay Server verbatim");
  assert.equal(relay.status.connected, true, "relay reports connected");
  assert.equal(relay.status.enabled, true, "relay reports enabled");

  // Inbound: a Relay Server frame is forwarded raw into the upstream Soloist socket.
  relayConn!.send('{"type":"command","command":"pause"}');
  for (let i = 0; i < 100 && !gotUpstream.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(gotUpstream, ['{"type":"command","command":"pause"}'], "Relay Server frame forwarded raw upstream");

  relay.stop();
  hub.stop();
  upstream.close();
  relaySrv.close();
});


// buildArgv reflects the Soloist command line; a change to any of the args means
// the running Soloist is stale and needs a restart.
await test("buildArgv Soloist command line", async () => {
  const base = { soloist: { deviceName: "d", apiKey: "k", dataDir: "/data", extraArgs: [], pipewireDevice: "" }, soloistWs: "127.0.0.1:3678" } as unknown as Config;
  assert.deepEqual(
    buildArgv(base),
    ["-w", "127.0.0.1:3678", "--device-name", "d", "--api-key", "k", "--data-dir", "/data"],
    "buildArgv renders the Soloist command line",
  );

  // Docker pin (main.js --pipewire-device) appends when config has no explicit device.
  setPipewireDeviceOverride("soloist-sink");
  assert.ok(
    buildArgv(base).join(" ").endsWith("--pipewire-device soloist-sink"),
    "buildArgv appends the Docker pipewire pin when config leaves it empty",
  );
  // An explicit config value wins over the pin.
  const pinned = { ...base, soloist: { ...(base as any).soloist, pipewireDevice: "alsa_x" } } as unknown as Config;
  assert.ok(buildArgv(pinned).includes("alsa_x") && !buildArgv(pinned).includes("soloist-sink"),
    "explicit pipewire_device overrides the Docker pin");
  setPipewireDeviceOverride(""); // reset so later assertions see no pin
});

// Run mode is explicit (--docker), never inferred from --pipewire-device — so a standalone
// user can pin Soloist's output device without turning on the Docker fan-out (ADR-0015).
await test("run mode is explicit, not inferred from --pipewire-device", async () => {
  assert.equal(isDockerMode(), false, "default is standalone");
  setPipewireDeviceOverride("hw:0");
  assert.equal(isDockerMode(), false, "a --pipewire-device (standalone output pin) does not imply Docker mode");
  const cfg = { soloist: { deviceName: "d", apiKey: "k", dataDir: "/data", extraArgs: [], pipewireDevice: "" }, soloistWs: "x" } as unknown as Config;
  assert.ok(buildArgv(cfg).join(" ").endsWith("--pipewire-device hw:0"), "standalone --pipewire-device still flows to Soloist argv");
  setDockerMode(true);
  assert.equal(isDockerMode(), true, "--docker turns on Docker mode");
  setDockerMode(false);
  setPipewireDeviceOverride("");
  assert.equal(isDockerMode(), false, "reset to standalone");
});


// SoloistControl: pending derives from live config vs last-spawned args; restart clears it.
await test("SoloistControl pending vs applied", async () => {
  const cfg = { soloist: { deviceName: "d", apiKey: "k", dataDir: "/data", extraArgs: [], pipewireDevice: "" }, soloistWs: "127.0.0.1:3678" } as unknown as Config;
  const control = new SoloistControl();
  assert.equal(control.pendingRestart(cfg), false, "no spawn yet -> not pending");
  control.markApplied(cfg);
  assert.equal(control.pendingRestart(cfg), false, "fresh spawn matches config -> not pending");
  cfg.soloist.deviceName = "renamed";
  assert.equal(control.pendingRestart(cfg), true, "device name change -> pending");
  cfg.soloist.deviceName = "d";
  assert.equal(control.pendingRestart(cfg), false, "reverted change -> not pending");
  cfg.soloistWs = "127.0.0.1:9999";
  assert.equal(control.pendingRestart(cfg), true, "soloist_ws change -> pending");
  control.restart(cfg);
  assert.equal(control.pendingRestart(cfg), false, "restart clears pending optimistically");
});


// Integration: restart aborts the current Soloist run and the supervise loop
// re-spawns (the Proxy — driven by the same process — is never dropped), while a
// real shutdown ends the loop.
await test("supervise restart aborts current run", async () => {
  const sdir = mkdtempSync(join(tmpdir(), "sup-"));
  const logf = join(sdir, "runs.log");
  const script = join(sdir, "fake-soloist.sh");
  writeFileSync(script, `#!/bin/sh\necho run >> ${logf}\nexec sleep 30\n`, { mode: 0o755 });
  const supCfg = { soloist: { deviceName: "d", apiKey: "k", dataDir: sdir, extraArgs: [], pipewireDevice: "" }, soloistWs: "127.0.0.1:1", web: { username: "u", password: "p", sessionSecret: "" } } as unknown as Config;
  const control = new SoloistControl();
  const ac = new AbortController();
  const runs = () => { try { return readFileSync(logf, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const waitFor = async (n: number) => { for (let i = 0; i < 150 && runs() < n; i++) await new Promise((r) => setTimeout(r, 20)); };

  const supP = supervise(supCfg, { signal: ac.signal, control, acquire: async () => script });
  let supErr: Error | null = null;
  supP.catch((e) => (supErr = e as Error));

  await waitFor(1);
  assert.equal(runs(), 1, "soloist spawned once");
  assert.equal(control.pendingRestart(supCfg), false, "fresh spawn -> not pending");

  supCfg.soloist.deviceName = "renamed";
  assert.equal(control.pendingRestart(supCfg), true, "soloist-arg change -> pending restart");

  control.restart(supCfg);
  await waitFor(2);
  assert.equal(runs(), 2, "restart re-spawned soloist without ending the loop");
  assert.equal(supErr, null, "supervise stays running across a restart");

  ac.abort();
  await supP.catch(() => {});
  const finalErr: unknown = supErr;
  assert.ok(finalErr instanceof Aborted, "shutdown ends the supervise loop with Aborted");
  rmSync(sdir, { recursive: true, force: true });
});


// Readiness gate: supervise parks (never acquires/spawns) until the config is
// minimally valid, then spawns once web creds land — so completing first-run setup
// starts Soloist without a process restart.
await test("supervise readiness gate parks", async () => {
  const sdir = mkdtempSync(join(tmpdir(), "sup-gate-"));
  const script = join(sdir, "fake-soloist.sh");
  writeFileSync(script, `#!/bin/sh\nexec sleep 30\n`, { mode: 0o755 });
  // Ready except for web creds (mirrors the migrated config before first-run setup).
  const gateCfg = { soloist: { deviceName: "d", apiKey: "k", dataDir: sdir, extraArgs: [], pipewireDevice: "" }, soloistWs: "127.0.0.1:1", web: { username: "", password: "", sessionSecret: "" } } as unknown as Config;
  const ac = new AbortController();
  let acquired = false;
  const supP = supervise(gateCfg, { signal: ac.signal, acquire: async () => { acquired = true; return script; } });
  supP.catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(acquired, false, "supervise parks (no acquire) while web creds unset");

  gateCfg.web.username = "dj";
  gateCfg.web.password = "pw";
  for (let i = 0; i < 200 && !acquired; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(acquired, true, "supervise spawns once creds land — no restart needed");
  ac.abort();
  await supP.catch(() => {});
  rmSync(sdir, { recursive: true, force: true });
});


// Supervisor state machine: soloistStatus() tracks the loop's transient phase. Drive
// a full cycle — park → acquire → run → exit-10 re-acquire → run → exit-1 backoff →
// shutdown — and assert it visits each boundary in order. Records every setState so
// transient phases (starting/running) are captured without racing the poller.
await test("supervise state machine transitions", async () => {
  const sdir = mkdtempSync(join(tmpdir(), "sup-state-"));
  // First build "expires" (exit 10 -> re-acquire), second "crashes" (exit 1 -> backoff);
  // each runs ~200ms so the running phase is observable before it exits.
  const expires = join(sdir, "expires.sh");
  const crashes = join(sdir, "crashes.sh");
  writeFileSync(expires, `#!/bin/sh\nsleep 0.2\nexit 10\n`, { mode: 0o755 });
  writeFileSync(crashes, `#!/bin/sh\nsleep 0.2\nexit 1\n`, { mode: 0o755 });
  const builds = [expires, crashes];
  let acq = 0;
  // Not ready (no web creds) so supervise parks in `waiting` until creds land.
  const stCfg = { soloist: { deviceName: "d", apiKey: "k", dataDir: sdir, extraArgs: [], pipewireDevice: "" }, soloistWs: "127.0.0.1:1", web: { username: "", password: "", sessionSecret: "" } } as unknown as Config;
  const control = new SoloistControl();
  const history: string[] = [];
  const record = control.setState.bind(control);
  control.setState = (s) => { history.push(s); record(s); };
  const ac = new AbortController();
  const waitState = async (s: string) => { for (let i = 0; i < 300 && control.soloistStatus().state !== s; i++) await new Promise((r) => setTimeout(r, 20)); };

  const supP = supervise(stCfg, { signal: ac.signal, control, acquire: async () => builds[Math.min(acq++, builds.length - 1)] });
  supP.catch(() => {});

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(control.soloistStatus().state, "waiting", "parks in waiting before config is ready");
  stCfg.web.username = "dj";
  stCfg.web.password = "pw";

  await waitState("backoff");
  ac.abort();
  await waitState("stopped");
  await supP.catch(() => {});

  assert.deepEqual(
    history,
    ["waiting", "acquiring", "starting", "running", "expired-reacquiring", "starting", "running", "backoff", "stopped"],
    "state machine visits each loop boundary in order",
  );
  assert.deepEqual(control.soloistStatus(), { state: "stopped" }, "soloistStatus exposes the live terminal state");
  rmSync(sdir, { recursive: true, force: true });
});


// PipeWire fan-out (ADR-0011, ticket T9).
const pwDump = JSON.stringify([
  { info: { props: { "media.class": "Audio/Sink", "node.name": "soloist-sink", "node.description": "Soloist" } } },
  { info: { props: { "media.class": "Audio/Sink", "node.name": "Spotify", "node.description": "Snapserver" } } },
  { info: { props: { "media.class": "Audio/Sink", "node.name": "alsa_output.hw_0", "node.description": "Speakers" } } },
  { info: { props: { "media.class": "Audio/Sink", "node.name": "bare" } } },
  { info: { props: { "media.class": "Audio/Source", "node.name": "mic" } } },
  { other: true },
]);
await test("parseSinks", async () => {
assert.deepEqual(
  parseSinks(pwDump, ["Spotify"]),
  [{ name: "alsa_output.hw_0", description: "Speakers" }, { name: "bare", description: "bare" }],
  "parseSinks: Audio/Sink only; soloist-sink + Snapserver capture node excluded; description falls back to name",
);
assert.deepEqual(parseSinks("not json"), [], "parseSinks: bad JSON -> []");
});


const sinksResp = pipewireSinksResponse([{ name: "alsa_output.hw_0", description: "Speakers" }]);
await test("pipewireSinksResponse ordering", async () => {
assert.equal(sinksResp[0].name, SNAPCAST_KEY, "pipewireSinksResponse: synthetic Snapcast toggle first");
assert.equal(sinksResp[1].name, "alsa_output.hw_0", "pipewireSinksResponse: real sinks follow");
});


// Standalone device picker (ADR-0015): listStandaloneSinks returns parseSinks with no
// exclude — every real Audio/Sink, no synthetic Snapcast entry (there is no fan-out),
// and no Snapserver-capture exclusion (stream_name is a Docker-only concept).
await test("standalone sink list omits the Snapcast toggle", async () => {
const standalone = parseSinks(pwDump);
assert.ok(!standalone.some((s) => s.name === SNAPCAST_KEY), "standalone list has no synthetic Snapcast entry");
assert.ok(standalone.some((s) => s.name === "Spotify"), "standalone list keeps sinks Docker would exclude as the Snapserver node");
assert.ok(standalone.some((s) => s.name === "alsa_output.hw_0"), "standalone list includes real hardware sinks");
});


// Sink cache starts empty with refreshedAt 0 ("never") so /api/pipewire-sinks knows to
// force a synchronous dump before the background poll has landed one. (refreshSinkCache
// itself shells out to pw-dump — exercised at runtime, not here.)
await test("Sink cache starts empty with refreshedAt 0 (\"never\") so /api/pipe...", async () => {
assert.deepEqual(getSinkCache(), { sinks: [], refreshedAt: 0 }, "getSinkCache: empty until first poll, refreshedAt 0 = never");
});


const dcfg = (snapcast: boolean, outputs: string[], streamName = "Spotify"): Config =>
  ({ audio: { snapcast, outputs }, streamName }) as unknown as Config;
await test("desiredTargets", async () => {
assert.deepEqual(desiredTargets(dcfg(true, ["alsa_x"])), ["Spotify", "alsa_x"], "desiredTargets: snapcast->streamName + hardware");
assert.deepEqual(desiredTargets(dcfg(false, ["alsa_x"])), ["alsa_x"], "desiredTargets: snapcast off drops stream node");
assert.deepEqual(
  desiredTargets(dcfg(true, ["snapcast", "soloist-sink", "alsa_x", "alsa_x"])),
  ["Spotify", "alsa_x"],
  "desiredTargets: reserved/internal names filtered, deduped",
);
});


const monitorListing = [
  "soloist-sink:monitor_FL",
  "  |-> old_sink:playback_FL",
  "soloist-sink:monitor_FR",
  "  |-> old_sink:playback_FR",
  "other-node:capture_FL",
  "  |-> unrelated:playback_FL",
].join("\n");
await test("parseMonitorTargets", async () => {
assert.deepEqual(parseMonitorTargets(monitorListing), ["old_sink"], "parseMonitorTargets: only soloist-sink monitor links");
assert.deepEqual(parseMonitorTargets(""), [], "parseMonitorTargets: empty -> []");
});


// reconcile happy path: link desired (Snapcast + hardware), unlink deselected old_sink.
await test("reconcile happy path", async () => {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "-i") return "Spotify:playback_FL\nalsa_x:playback_FL\n";
    if (args.includes("-l")) return monitorListing;
    return "";
  };
  const res = await reconcileOutputs(dcfg(true, ["alsa_x"]), { run, retries: 1, intervalMs: 0 });
  assert.deepEqual(res.linked, ["Spotify", "alsa_x"], "reconcile: enabled outputs linked");
  assert.deepEqual(res.removed, ["old_sink"], "reconcile: deselected link removed");
  assert.deepEqual(res.missing, [], "reconcile: nothing missing when nodes present");
  assert.ok(calls.includes("pw-link soloist-sink:monitor_FL Spotify:playback_FL"), "reconcile: snapcast FL linked");
  assert.ok(calls.includes("pw-link soloist-sink:monitor_FR alsa_x:playback_FR"), "reconcile: hardware FR linked");
  assert.ok(calls.includes("pw-link -d soloist-sink:monitor_FL old_sink:playback_FL"), "reconcile: deselected FL unlinked");
});


// reconcile: a configured output whose node never appears is skipped and flagged.
await test("reconcile skips absent node", async () => {
  const run: Runner = async (_cmd, args) => (args.includes("-l") ? "" : "");
  const res = await reconcileOutputs(dcfg(false, ["ghost"]), { run, retries: 1, intervalMs: 0 });
  assert.deepEqual(res.missing, ["ghost"], "reconcile: absent node flagged missing");
  assert.deepEqual(res.linked, [], "reconcile: absent node not linked");
});


// Per-output playback delay (ADR-0013, filter-chain).
await test("Per-output playback delay (ADR-0013, filter-chain)", async () => {
assert.deepEqual(desiredDelays(dcfg(true, ["alsa_x", "alsa_y"])), {}, "desiredDelays: no outputDelays configured -> {}");
});

await test("desiredDelays maps output delays", async () => {
  const withDelay = { audio: { snapcast: true, outputs: ["alsa_x", "alsa_y", "snapcast"], outputDelays: { alsa_x: 250, alsa_y: 0, ghost: 10 } }, streamName: "Spotify" } as unknown as Config;
  assert.deepEqual(desiredDelays(withDelay), { alsa_x: 250 }, "desiredDelays: only enabled hardware outputs with >0ms; snapcast/absent excluded");
});


const tokens = buildDelayTokens({ "alsa_output.hw:0": 250, "alsa/weird name!": 100 });
await test("tokens", async () => {
assert.equal(tokens.get("alsa_output.hw:0"), "alsa-output-hw-0", "buildDelayTokens: sanitizes to safe token");
assert.equal(tokens.get("alsa/weird name!"), "alsa-weird-name", "buildDelayTokens: strips/collapses unsafe chars");
});

await test("buildDelayTokens collision safety", async () => {
  const collide = buildDelayTokens({ "a!b": 1, "a?b": 2 });
  assert.equal(collide.get("a!b"), "a-b", "buildDelayTokens: first owner keeps the base token");
  assert.equal(collide.get("a?b"), "a-b-2", "buildDelayTokens: collision gets a -2 suffix");
});


await test("generateFilterChainConf output", async () => {
  const conf = generateFilterChainConf({ alsa_x: 250 }, buildDelayTokens({ alsa_x: 250 }));
  assert.ok(conf.includes("libpipewire-module-protocol-native"), "generateFilterChainConf: self-contained (protocol-native)");
  assert.ok(conf.includes("libpipewire-module-client-node"), "generateFilterChainConf: self-contained (client-node)");
  assert.ok(conf.includes("libpipewire-module-adapter"), "generateFilterChainConf: adapter module (filter node needs it)");
  assert.ok(conf.includes("audioconvert/libspa-audioconvert"), "generateFilterChainConf: spa-libs for audio.convert");
  assert.ok(conf.includes("node.autoconnect = false"), "generateFilterChainConf: autoconnect off (no leak to default sink)");
  assert.ok(conf.includes(`node.name = "${DELAY_PREFIX}alsa-x"`), "generateFilterChainConf: node.name is soloist-delay-<token>");
  assert.ok(conf.includes('"Delay (s)" = 0.250'), "generateFilterChainConf: ms converted to seconds");
});


// reconcile: a delayed output routes through the filter-chain node, not a direct link,
// and the shared child is spawned once (not per output) and killed on empty map.
await test("reconcile delayed output via filter-chain", async () => {
  const calls: string[] = [];
  const spawnedCmds: string[] = [];
  let killed = 0;
  const spawner: Spawner = (cmd, args) => {
    spawnedCmds.push([cmd, ...args].join(" "));
    return { kill: () => { killed++; }, on: () => {} } as unknown as ReturnType<Spawner>;
  };
  const run: Runner = async (_cmd, args) => {
    calls.push(["pw-link", ...args].join(" "));
    if (args[0] === "-i") return "input.soloist-delay-alsa-x:input_FL\nalsa_x:playback_FL\n";
    if (args.includes("-l")) return "";
    return "";
  };
  const delayedCfg = { audio: { snapcast: false, outputs: ["alsa_x"], outputDelays: { alsa_x: 250 } }, streamName: "Spotify" } as unknown as Config;
  const res = await reconcileOutputs(delayedCfg, { run, spawn: spawner, retries: 1, intervalMs: 0 });
  assert.deepEqual(res.linked, ["alsa_x"], "reconcile+delay: reported linked under the real sink name");
  assert.equal(spawnedCmds.length, 1, "reconcile+delay: one filter-chain child spawned, not one per output");
  assert.ok(spawnedCmds[0].startsWith("pipewire -c "), "reconcile+delay: spawns pipewire -c <conf>");
  assert.ok(calls.includes("pw-link soloist-sink:monitor_FL input.soloist-delay-alsa-x:input_FL"), "reconcile+delay: monitor -> filter input");
  assert.ok(calls.includes("pw-link output.soloist-delay-alsa-x:output_FL alsa_x:playback_FL"), "reconcile+delay: filter output -> hw sink");
  assert.ok(!calls.includes("pw-link soloist-sink:monitor_FL alsa_x:playback_FL"), "reconcile+delay: no direct link for a delayed output");

  // Unchanged delay map on the next reconcile -> no respawn.
  const res2 = await reconcileOutputs(delayedCfg, { run, spawn: spawner, retries: 1, intervalMs: 0 });
  assert.equal(spawnedCmds.length, 1, "reconcile+delay: same delay map does not respawn the child");
  void res2;

  // Delay removed -> child killed, no new spawn, direct link used.
  const undelayedCfg = { audio: { snapcast: false, outputs: ["alsa_x"], outputDelays: { alsa_x: 0 } }, streamName: "Spotify" } as unknown as Config;
  const res3 = await reconcileOutputs(undelayedCfg, { run, spawn: spawner, retries: 1, intervalMs: 0 });
  assert.equal(killed, 1, "reconcile: delay dropped to 0 kills the running filter-chain child");
  assert.equal(spawnedCmds.length, 1, "reconcile: dropping to 0 does not spawn a new child");
  assert.deepEqual(res3.linked, ["alsa_x"], "reconcile: output relinks directly once its delay is gone");
});


// no delay configured at all -> identical topology/behaviour to pre-ADR-0013 (ADR-0011).
await test("reconcile no-delay topology unchanged", async () => {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "-i") return "alsa_x:playback_FL\n";
    if (args.includes("-l")) return "";
    return "";
  };
  const spawner: Spawner = () => { throw new Error("must not spawn a filter-chain child with no delays configured"); };
  const res = await reconcileOutputs(dcfg(false, ["alsa_x"]), { run, spawn: spawner, retries: 1, intervalMs: 0 });
  assert.deepEqual(res.linked, ["alsa_x"], "reconcile no-delay: unchanged direct-link behaviour");
  assert.ok(calls.includes("pw-link soloist-sink:monitor_FL alsa_x:playback_FL"), "reconcile no-delay: direct link, same as ADR-0011");
});


// Landing-page view-model helpers.
await test("Landing-page view-model helpers", async () => {
assert.equal(fmtTime(0), "0:00");
assert.equal(fmtTime(194000), "3:14");
assert.equal(fmtTime(9000), "0:09", "seconds zero-padded");
assert.equal(fmtTime(-5), "0:00", "negatives clamp to zero");
});


// Sample built to the real Soloist Entity schema (decorations.identity/creators/
// parent/visual_identity/playback).
const entity = (name: string, artist: string, album: string, durationMs: number, covers: { url: string; size: string }[] = []) => ({
  uri: "spotify:track:x",
  entity_type: "track",
  decorations: {
    identity: { name },
    visual_identity: { cover: covers },
    parent: { entity: { decorations: { identity: { name: album } } } },
    creators: [{ entity: { decorations: { identity: { name: artist } } } }],
    playback: { duration_ms: durationMs },
  },
});
await test("readTrack view-model", async () => {
  const item = entity("Blinding Lights", "The Weeknd", "After Hours", 200000, [
    { url: "https://img/small", size: "small" },
    { url: "https://img/large", size: "large" },
  ]);
  const t = readTrack({ type: "track_changed", item });
  assert.deepEqual(t, { uri: "spotify:track:x", title: "Blinding Lights", artist: "The Weeknd", album: "After Hours", durationMs: 200000, art: "https://img/large" }, "readTrack: Entity decorations, prefers large cover");
  assert.equal(readTrack({ type: "auth_state", logged_in: true }), null, "readTrack: no item -> null");
});

await test("readPlayback view-model", async () => {
  const p = readPlayback({ type: "playback_state", status: "paused", position: { position_ms: 4200, timestamp_ms: 1788460353479, speed: 0 }, volume: 55 });
  assert.deepEqual(p, { positionMs: 4200, timestampMs: 1788460353479, speed: 0, playing: false, volume: 55 }, "readPlayback: status/position anchor/volume");
  const ps = readPlayback({ type: "position_sync", position: { position_ms: 10, timestamp_ms: 1788460353480, speed: 1 } });
  assert.deepEqual({ t: ps.timestampMs, s: ps.speed, pl: ps.playing }, { t: 1788460353480, s: 1, pl: undefined }, "readPlayback: position_sync carries timestamp_ms + speed, no status");
  assert.equal(readPlayback({ type: "playback_changed", status: "playing" }).playing, true, "readPlayback: status playing -> true");
  assert.equal(readPlayback({}).positionMs, null, "readPlayback: absent position -> null");
  assert.equal(readPlayback({}).timestampMs, null, "readPlayback: absent position -> null timestamp");
});

await test("readQueue view-model", async () => {
  const q = readQueue({ type: "queue_changed", upcoming: [{ uid: "a", source: "context", item: entity("Levitating", "Dua Lipa", "", 203000) }] });
  assert.deepEqual(q, [{ uri: "spotify:track:x", title: "Levitating", artist: "Dua Lipa", album: "", durationMs: 203000, art: "" }], "readQueue: reads upcoming list");
  assert.equal(readQueue({ type: "track_changed" }), null, "readQueue: no upcoming -> null");
});

await test("hashPassword / verifyPassword", async () => {
  const h = hashPassword("hunter2");
  assert.ok(isPasswordHashed(h) && h.startsWith("scrypt$"), "hashPassword: scrypt-encoded");
  assert.equal(h.includes("hunter2"), false, "hashPassword: plaintext not present");
  assert.notEqual(hashPassword("hunter2"), h, "hashPassword: per-call random salt");
  assert.ok(verifyPassword("hunter2", h), "verifyPassword: correct password");
  assert.equal(verifyPassword("wrong", h), false, "verifyPassword: wrong password");
  assert.ok(verifyPassword("legacy", "legacy"), "verifyPassword: legacy cleartext accepted");
  assert.equal(verifyPassword("legacy", "other"), false, "verifyPassword: legacy cleartext mismatch");
});


// Shared mock req/res for the setup-handler tests below. fakeRes captures the response
// body; setupReq builds an IncomingMessage with a readable body stream.
function fakeRes() {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    done,
    writeHead(code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string | Buffer) {
      if (chunk) this.body += chunk.toString();
      resolveDone();
      return this;
    },
  };
}
const setupReq = (method: string, url: string, body = ""): IncomingMessage => {
  const r = Readable.from(body ? [Buffer.from(body)] : []) as unknown as IncomingMessage & Record<string, unknown>;
  r.method = method;
  r.url = url;
  (r as { headers: Record<string, string> }).headers = {};
  (r as { socket: unknown }).socket = { remoteAddress: "test" };
  return r as IncomingMessage;
};

// First-run setup gating: creds unset -> only /setup served, everything else fails
// closed; POST /setup sets creds + redirects to login; then /setup is unreachable.
await test("first-run setup gating", async () => {
  const call = (r: ReturnType<typeof fakeRes>, req: IncomingMessage, cfg: Config) =>
    handleWebRequest(req, r as unknown as ServerResponse, cfg, setupCfgPath);

  const setupDir = mkdtempSync(join(tmpdir(), "setup-"));
  const setupCfgPath = join(setupDir, "config.yaml");
  const scfg = defaultConfig();
  scfg.web.sessionSecret = "sess"; // as ensureSecrets would have minted on boot
  assert.equal(webConfigured(scfg), false, "fresh config: web not configured");
  assert.equal(soloistReady(scfg), false, "fresh config: soloist not ready");

  let r = fakeRes();
  assert.equal(call(r, setupReq("GET", "/setup"), scfg), true, "GET /setup handled in setup mode");
  assert.equal(r.statusCode, 200, "GET /setup served in setup mode");
  assert.match(r.body, /Soloist Proxy — Setup/, "setup page shell served (Vue mounts the form client-side)");

  r = fakeRes();
  call(r, setupReq("GET", "/"), scfg);
  assert.equal(r.statusCode, 302, "root redirects in setup mode");
  assert.equal(r.headers.location, "/setup", "root redirects to /setup");

  for (const p of ["/api/config", "/api/config-summary", "/api/relay", "/login"]) {
    r = fakeRes();
    call(r, setupReq("GET", p), scfg);
    assert.equal(r.statusCode, 503, `${p} fails closed in setup mode`);
  }

  // POST /setup with mismatched passwords: error redirect, creds stay unset.
  r = fakeRes();
  call(r, setupReq("POST", "/setup", "username=admin&password=pw1&confirm=pw2"), scfg);
  await r.done;
  assert.equal(r.statusCode, 302, "mismatch redirects");
  assert.equal(r.headers.location, "/setup?error=1", "mismatch -> setup error");
  assert.equal(webConfigured(scfg), false, "mismatch did not set creds");

  // POST /setup with valid input: sets creds, writes file, redirects to login.
  r = fakeRes();
  call(r, setupReq("POST", "/setup", "username=dj&password=hunter2&confirm=hunter2"), scfg);
  await r.done;
  assert.equal(r.statusCode, 302, "valid setup redirects");
  assert.equal(r.headers.location, "/login", "valid setup -> login");
  assert.equal(scfg.web.username, "dj", "username set from setup");
  assert.ok(isPasswordHashed(scfg.web.password), "setup password stored hashed, not cleartext");
  assert.ok(verifyPassword("hunter2", scfg.web.password), "setup password verifies");
  assert.equal(webConfigured(scfg), true, "creds now configured");
  const savedSetup = loadConfig(setupCfgPath);
  assert.equal(savedSetup.web.username, "dj", "setup creds persisted to file");
  assert.ok(isPasswordHashed(savedSetup.web.password) && verifyPassword("hunter2", savedSetup.web.password), "setup password persisted hashed + verifies");
  assert.equal(soloistReady(scfg), false, "creds only: soloist still not ready (args absent)");

  // Setup done: the Setup Page is no longer reachable.
  r = fakeRes();
  call(r, setupReq("GET", "/setup"), scfg);
  assert.equal(r.statusCode, 302, "configured: /setup redirects");
  assert.equal(r.headers.location, "/", "configured: /setup -> /");

  // With web creds + soloist args, supervision is allowed to start.
  scfg.soloist.deviceName = "Speaker";
  scfg.soloist.apiKey = "key";
  assert.equal(soloistReady(scfg), true, "web creds + soloist args -> ready");
});


// Setup TOCTOU guard (item D): two concurrent POST /setup for the same config path
// racing the webConfigured() check must not both save.
await test("setup TOCTOU guard", async () => {
  const raceDir = mkdtempSync(join(tmpdir(), "setup-race-"));
  const racePath = join(raceDir, "config.yaml");
  const raceCfg = defaultConfig();
  raceCfg.web.sessionSecret = "sess";
  const body = "username=dj&password=hunter2&confirm=hunter2";

  const r1 = fakeRes();
  const r2 = fakeRes();
  handleWebRequest(setupReq("POST", "/setup", body), r1 as unknown as ServerResponse, raceCfg, racePath);
  handleWebRequest(setupReq("POST", "/setup", body), r2 as unknown as ServerResponse, raceCfg, racePath);
  await Promise.all([r1.done, r2.done]);

  // Node's fully-synchronous-after-readBody handler means one request's completion
  // (claim through save) always finishes atomically before the other's continuation
  // runs, so the loser may see either this latch or the pre-existing webConfigured()
  // check — either way, exactly one save must win and the account must be uncorrupted.
  assert.deepEqual([r1.statusCode, r2.statusCode], [302, 302], "both requests get a redirect response");
  const locations = [r1.headers.location, r2.headers.location];
  assert.ok(locations.includes("/login"), "one request completes setup and redirects to login");
  assert.ok(locations.every((l) => l === "/login" || l === "/setup?error=1"), "no other outcome for a concurrent setup POST");
  assert.equal(webConfigured(raceCfg), true, "the winner's creds were applied");
  assert.equal(loadConfig(racePath).web.username, "dj", "exactly one save persisted, uncorrupted");
  rmSync(raceDir, { recursive: true, force: true });
});


await test("highlightJson escapes XSS payloads to inert text", async () => {
  // The two canonical break-out attempts (ADR-0016): an attribute-handler injection and
  // a tag that tries to close hljs's own <pre><code> wrapper. Both must come back with
  // every raw angle bracket from the input HTML-escaped.
  for (const payload of ['<img src=x onerror=alert(1)>', '</code></pre><script>alert(1)</script>']) {
    const out = await highlightJson(JSON.stringify({ v: payload }));
    // hljs wraps tokens in its own <span class="hljs-…"> tags; strip those and any of its
    // closing </span>, then assert no raw < or > from the input survives.
    const bare = out.replace(/<span class="hljs-[^"]*">/g, "").replace(/<\/span>/g, "");
    assert.ok(!bare.includes("<"), `escaped output leaked a raw '<': ${out}`);
    assert.ok(!bare.includes(">"), `escaped output leaked a raw '>': ${out}`);
    assert.ok(out.includes("&lt;") && out.includes("&gt;"), "payload angle brackets should render as entities");
    assert.ok(!out.includes("<img") && !out.includes("<script"), `live tag survived: ${out}`);
  }
});

await test("hljs + theme CSS live in the Debug async chunk, not any entry bundle", async () => {
  // manifest: true (vite.config.ts) lets us prove the code-split from the emitted graph
  // rather than by eyeballing bundle sizes (ADR-0018).
  const webDir = new URL("./web/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(".vite/manifest.json", webDir), "utf8")) as Record<
    string,
    { file: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[]; css?: string[] }
  >;

  const debug = manifest["pages/Debug.vue"];
  assert.ok(debug, "Debug.vue must be its own chunk in the manifest");
  assert.equal(debug.isDynamicEntry, true, "Debug.vue must be a dynamic (lazy) chunk, not an entry");

  const hljsKeys = Object.keys(manifest).filter((k) => k.includes("highlight.js"));
  assert.ok(hljsKeys.some((k) => k.endsWith("/core.js")), "hljs core must be a manifest chunk");
  assert.ok(hljsKeys.some((k) => k.endsWith("/languages/json.js")), "hljs json grammar must be a manifest chunk");
  for (const k of hljsKeys) assert.equal(manifest[k].isDynamicEntry, true, `${k} must be an async chunk`);

  // Debug pulls hljs core + json only via dynamicImports (the await import() in the helper).
  for (const k of hljsKeys) assert.ok((debug.dynamicImports ?? []).includes(k), `Debug chunk must dynamic-import ${k}`);

  // No entry bundle may reach hljs through *static* imports (transitive walk).
  for (const [key, rec] of Object.entries(manifest)) {
    if (!rec.isEntry) continue;
    const seen = new Set<string>();
    const stack = [...(rec.imports ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      assert.ok(!cur.includes("highlight.js"), `entry ${key} statically imports hljs via ${cur}`);
      stack.push(...(manifest[cur]?.imports ?? []));
    }
  }

  // The theme CSS rides the Debug chunk and actually carries hljs rules.
  assert.ok(debug.css?.length, "Debug chunk must ship a CSS asset (the hljs theme)");
  const themeCss = readFileSync(new URL(debug.css![0], webDir), "utf8");
  assert.ok(themeCss.includes(".hljs"), "Debug chunk CSS must contain hljs theme rules");
});


console.log(`\nselftest: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

