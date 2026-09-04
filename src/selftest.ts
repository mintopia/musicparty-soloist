import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { detectArch, AcquisitionError, tarballUrl } from "./acquire.js";
import { checkAuth, sameOrigin } from "./auth.js";
import { safeStrEqual } from "./util.js";
import { backoffStep, BACKOFF_BASE, BACKOFF_MAX } from "./supervisor.js";
import { decodeFrame, shouldAutoplay, AUTOPLAY_FRAMES, SoloistHub, listenParts, type UpstreamFrame } from "./proxy.js";
import { resolveWebhookUrl, WebhookQueue, recordWebhookStat, type WebhookStats } from "./webhooks.js";
import { SoloistRelay } from "./relay.js";
import { once } from "node:events";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { loadConfig, saveConfig, ensureSecrets, ConfigError, coerceBool, coerceInt, coerceFloat, maskConfig, configSummary, applyApiConfig, defaultConfig, soloistReady, hashPassword, verifyPassword, isPasswordHashed, DEFAULT_OVERLAY, type Config } from "./config.js";
import { signSession, verifySession, parseCookies, sessionUser, webConfigured, webhooksView, relayView, overlayBootstrap, handleWebRequest, SESSION_COOKIE } from "./web.js";
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


// Webhook delivery stats: ok/fail counters, lastStatus/lastError per destination.
const wstats: WebhookStats = new Map();
await test("wstats", async () => {
recordWebhookStat(wstats, "http://a", 200, null);
recordWebhookStat(wstats, "http://a", 204, null);
assert.deepEqual(wstats.get("http://a")!.ok, 2, "2xx increments ok");
assert.equal(wstats.get("http://a")!.fail, 0, "2xx does not fail");
assert.equal(wstats.get("http://a")!.lastStatus, 204, "lastStatus tracks last delivery");
recordWebhookStat(wstats, "http://a", 500, null);
assert.equal(wstats.get("http://a")!.fail, 1, "5xx increments fail");
assert.equal(wstats.get("http://a")!.lastError, "HTTP 500", "non-2xx status recorded as lastError");
recordWebhookStat(wstats, "http://a", null, "timeout");
assert.equal(wstats.get("http://a")!.fail, 2, "network error increments fail");
assert.equal(wstats.get("http://a")!.lastError, "timeout", "network error message recorded");
assert.equal(wstats.get("http://a")!.lastStatus, null, "network error clears lastStatus");
assert.ok(wstats.get("http://a")!.lastAt! > 0, "lastAt timestamp set");
});


// webhooksView: reports config + stats, never the secret value.
const viewCfg = { webhooks: { defaultUrl: "http://def", urls: { track_changed: "http://tc" }, secret: "topsecret", delayMs: 0 } } as unknown as Config;
const view = webhooksView(viewCfg, wstats) as { config: { defaultUrl: string; urls: Record<string, string>; hasSecret: boolean }; stats: Record<string, unknown> };
await test("webhooksView hides secret", async () => {
assert.equal(view.config.hasSecret, true, "secret presence exposed as boolean");
assertNoLeak("webhooksView", view, ["topsecret"]);
assert.deepEqual(view.config.urls, { track_changed: "http://tc" }, "type->url overrides reported");
assert.equal(view.config.defaultUrl, "http://def", "default url reported");
assert.ok(view.stats["http://a"], "live stats map included");
});

const noSecretView = webhooksView({ webhooks: { defaultUrl: "", urls: {}, secret: "", delayMs: 0 } } as unknown as Config, new Map()) as { config: { hasSecret: boolean } };
await test("webhooksView empty secret", async () => {
assert.equal(noSecretView.config.hasSecret, false, "empty secret -> hasSecret false");
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
assert.equal(verifySession(signed.slice(0, -1) + "x", SECRET), null, "tampered signature rejected");
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
  hub.register(ro as unknown as WebSocket, { readOnly: true });
  assert.deepEqual(ro.sent, ['{"type":"playback_state","playing":true}'], "read-only client gets state replay on connect");
  await hub.forward(ro as unknown as WebSocket, Buffer.from('{"type":"command","command":"play"}') as unknown as RawData, false);
  assert.deepEqual(gotUpstream, [], "read-only client frames dropped, never forwarded upstream");

  const ctrl = fake();
  hub.register(ctrl as unknown as WebSocket, {});
  assert.deepEqual(ctrl.sent, ['{"type":"playback_state","playing":true}'], "control client gets state replay on connect");
  await hub.forward(ctrl as unknown as WebSocket, Buffer.from('{"type":"command","command":"play"}') as unknown as RawData, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(gotUpstream, ['{"type":"command","command":"play"}'], "control client frames forwarded upstream");

  hub.stop();
  upstream.close();
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

  for (const p of ["/api/config", "/api/config-summary", "/api/webhooks", "/login"]) {
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

