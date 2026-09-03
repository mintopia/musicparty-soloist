import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { detectArch, AcquisitionError, tarballUrl } from "./acquire.js";
import { checkAuth, decodeFrame, shouldAutoplay, resolveWebhookUrl, WebhookQueue, recordWebhookStat, AUTOPLAY_FRAMES, SoloistHub, type UpstreamFrame, type WebhookStats } from "./proxy.js";
import { once } from "node:events";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { loadConfig, saveConfig, ensureSecrets, ConfigError, coerceBool, coerceInt, maskConfig, configSummary, applyApiConfig, DEFAULT_OVERLAY, type Config } from "./config.js";
import { signSession, verifySession, parseCookies, sessionUser, webConfigured, webhooksView, overlayBootstrap, SESSION_COOKIE } from "./web.js";

// Overlay engine lives in src/web/ (browser ESM, copied to dist/web/). Computed
// specifier so tsc treats it as `any` — it ships no .d.ts.
const engine = await import(new URL("./web/overlay.js", import.meta.url).href);
const { parseLRC, currentIndex } = engine as {
  parseLRC(text: string): { time: number; text: string }[];
  currentIndex(lines: { time: number }[], t: number): number;
};

function req(headers: Record<string, string>, url = "/"): IncomingMessage {
  return { headers, url, socket: { remoteAddress: "test" } } as unknown as IncomingMessage;
}

assert.equal(detectArch("x64"), "x86_64");
assert.equal(detectArch("arm64"), "arm64");
assert.equal(detectArch("arm"), "arm32");
assert.throws(() => detectArch("sparc"), AcquisitionError);
assert.equal(tarballUrl("arm64", "https://x/y/"), "https://x/y/soloist_release_arm64.tar.gz");

const CT = "s3cret";
const RT = "readonly-tok";
const AUTH_SECRET = "authsess";
const authCfg = (token: string, readonlyToken = "", web = { username: "", password: "", sessionSecret: AUTH_SECRET }): Config =>
  ({ proxy: { token, readonlyToken }, web }) as unknown as Config;
assert.equal(checkAuth(req({ authorization: `Bearer ${CT}` }), authCfg(CT, RT)), "control", "auth token -> control");
assert.equal(checkAuth(req({}, `/?token=${CT}`), authCfg(CT, RT)), "control", "query auth token -> control");
assert.equal(checkAuth(req({ authorization: `Bearer ${RT}` }), authCfg(CT, RT)), "readonly", "readonly token -> readonly");
assert.equal(checkAuth(req({ authorization: "Bearer nope" }), authCfg(CT, RT)), "none", "bad token -> none");
assert.equal(checkAuth(req({}), authCfg(CT, RT)), "none", "missing token -> none");
assert.equal(checkAuth(req({ authorization: "Bearer " + CT + "x" }), authCfg(CT, RT)), "none", "wrong length -> none");
assert.equal(checkAuth(req({}, "/?token="), authCfg(CT, "")), "none", "empty presented never matches empty readonly");
assert.equal(
  checkAuth(req({ cookie: `${SESSION_COOKIE}=${signSession("admin", AUTH_SECRET)}` }), authCfg(CT, RT, { username: "admin", password: "pw", sessionSecret: AUTH_SECRET })),
  "control",
  "valid web session -> control",
);

const buf = (s: string): RawData => Buffer.from(s) as unknown as RawData;
assert.deepEqual(decodeFrame(buf('{"type":"auth_state","logged_in":true}'), false), {
  type: "auth_state",
  message: { type: "auth_state", logged_in: true },
  raw: '{"type":"auth_state","logged_in":true}',
});
assert.equal(decodeFrame(buf("{"), false), null, "malformed JSON skipped");
assert.equal(decodeFrame(buf('{"no":"type"}'), false), null, "type-less frame skipped");
assert.equal(decodeFrame(buf('"a string"'), false), null, "non-object JSON skipped");
assert.equal(decodeFrame(buf('{"type":"x"}'), true), null, "binary frame skipped");

assert.equal(coerceBool("true", false), true);
assert.equal(coerceBool("NO", true), false);
assert.equal(coerceBool("1", false), true);
assert.equal(coerceBool("", true), true, "empty falls back to default");
assert.equal(coerceBool(undefined, false), false, "unset falls back to default");
assert.equal(coerceBool("garbage", true), true, "unrecognized falls back to default");
assert.equal(coerceInt("42", 0), 42);
assert.equal(coerceInt("", 5), 5, "empty falls back to default");
assert.equal(coerceInt("nope", 7), 7, "non-numeric falls back to default");

const frame = (msg: Record<string, unknown>): UpstreamFrame => ({
  type: String(msg.type),
  message: msg,
  raw: JSON.stringify(msg),
});
const loggedIn = frame({ type: "auth_state", logged_in: true });
assert.equal(shouldAutoplay({ fired: false }, frame({ type: "auth_state", logged_in: false })), false, "not logged in: no autoplay");
assert.equal(shouldAutoplay({ fired: false }, loggedIn), true, "false->true fires");
assert.equal(shouldAutoplay({ fired: false }, loggedIn), true, "already-true on connect fires");
assert.equal(shouldAutoplay({ fired: true }, loggedIn), false, "once-per-connection guard");
assert.equal(shouldAutoplay({ fired: false }, frame({ type: "playback_state", logged_in: true })), false, "non-auth_state ignored");

assert.deepEqual(
  AUTOPLAY_FRAMES,
  [{ type: "command", command: "activate" }, { type: "command", command: "play" }],
  "autoplay injects Soloist command envelopes (activate then play)",
);

const whCfg = { defaultUrl: "http://def", urls: { track_changed: "http://tc", error: "http://err" }, secret: "", delayMs: 0 };
assert.equal(resolveWebhookUrl("auth_state", whCfg), "http://def", "state event -> default_url");
assert.equal(resolveWebhookUrl("track_changed", whCfg), "http://tc", "override replaces default");
assert.equal(resolveWebhookUrl("error", whCfg), "http://err", "error only with explicit override");
assert.equal(resolveWebhookUrl("command_result", whCfg), null, "command_result without override -> none");
assert.equal(resolveWebhookUrl("auth_state", { defaultUrl: "", urls: {}, secret: "", delayMs: 0 }), null, "no default/override -> none");

const fires: number[] = [];
const spaced: (() => void)[] = [];
const q1 = new WebhookQueue(100, { schedule: (fn, ms) => { assert.equal(ms, 100, "throttle spacing == delayMs"); spaced.push(fn); } });
q1.push(() => fires.push(1));
assert.deepEqual(fires, [1], "first task fires immediately");
q1.push(() => fires.push(2));
q1.push(() => fires.push(3));
assert.deepEqual(fires, [1], "throttle holds queued tasks");
spaced.shift()!();
spaced.shift()!();
assert.deepEqual(fires, [1, 2, 3], "queued tasks drain FIFO");

const order: string[] = [];
const drops: number[] = [];
const held: (() => void)[] = [];
const q2 = new WebhookQueue(50, { cap: 3, schedule: (fn) => held.push(fn), onDrop: () => drops.push(1) });
for (const c of ["A", "B", "C", "D", "E"]) q2.push(() => order.push(c));
assert.equal(q2.size(), 3, "queue bounded at cap");
assert.equal(drops.length, 1, "one drop at cap");
while (held.length) held.shift()!();
assert.deepEqual(order, ["A", "C", "D", "E"], "oldest queued (B) dropped, rest FIFO");

const sync: number[] = [];
const q0 = new WebhookQueue(0, { schedule: () => assert.fail("no timer when delayMs is 0") });
q0.push(() => sync.push(1));
q0.push(() => sync.push(2));
assert.deepEqual(sync, [1, 2], "delayMs 0 drains synchronously in order");

// Webhook delivery stats: ok/fail counters, lastStatus/lastError per destination.
const wstats: WebhookStats = new Map();
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

// webhooksView: reports config + stats, never the secret value.
const viewCfg = { webhooks: { defaultUrl: "http://def", urls: { track_changed: "http://tc" }, secret: "topsecret", delayMs: 0 } } as unknown as Config;
const view = webhooksView(viewCfg, wstats) as { config: { defaultUrl: string; urls: Record<string, string>; hasSecret: boolean }; stats: Record<string, unknown> };
assert.equal(view.config.hasSecret, true, "secret presence exposed as boolean");
assert.equal(JSON.stringify(view).includes("topsecret"), false, "secret value never serialized");
assert.deepEqual(view.config.urls, { track_changed: "http://tc" }, "type->url overrides reported");
assert.equal(view.config.defaultUrl, "http://def", "default url reported");
assert.ok(view.stats["http://a"], "live stats map included");
const noSecretView = webhooksView({ webhooks: { defaultUrl: "", urls: {}, secret: "", delayMs: 0 } } as unknown as Config, new Map()) as { config: { hasSecret: boolean } };
assert.equal(noSecretView.config.hasSecret, false, "empty secret -> hasSecret false");

// Lyrics Overlay engine: parseLRC + currentIndex (folded in from the prototype).
{
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
}

// Overlay bootstrap: embeds only the Read-only Token + Overlay Config subset,
// never other secrets, and escapes `<` so it can't break out of <script>.
{
  const ovCfg = {
    proxy: { token: "CONTROL-SECRET", readonlyToken: "RO-TOKEN", listen: "x" },
    soloist: { apiKey: "SPOTIFY-KEY" },
    web: { password: "webpass", sessionSecret: "sess" },
    webhooks: { secret: "whsecret" },
    overlay: { ...DEFAULT_OVERLAY, effect: "</script><x>" },
  } as unknown as Config;
  const boot = overlayBootstrap(ovCfg);
  assert.match(boot, /RO-TOKEN/, "read-only token embedded");
  assert.equal(boot.includes("CONTROL-SECRET"), false, "Auth Token never embedded");
  assert.equal(boot.includes("SPOTIFY-KEY"), false, "API Key never embedded");
  assert.equal(boot.includes("webpass"), false, "web password never embedded");
  assert.equal(boot.includes("sess"), false, "session secret never embedded");
  assert.equal(boot.includes("whsecret"), false, "webhook secret never embedded");
  assert.equal(boot.indexOf("</script>"), boot.lastIndexOf("</script>"), "only the wrapper's closing tag — no </script> breakout from config");
  assert.match(boot, /\\u003c\/script>/, "`<` in overlay config escaped");
}

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
assert.equal(cfg.soloist.deviceName, "Party Speaker", "literal device_name, no interpolation");
assert.equal(cfg.soloist.apiKey, "key123", "literal value, no env");
assert.equal(cfg.proxy.token, "tok123");
assert.equal(cfg.proxy.listen, "127.0.0.1:9000");
assert.equal(cfg.autoplay, false, "autoplay defaults off when absent");
assert.equal(cfg.webhooks.defaultUrl, "", "webhooks absent -> empty default_url");
assert.deepEqual(cfg.webhooks.urls, {}, "webhooks absent -> no urls");
assert.equal(cfg.webhooks.delayMs, 0, "delay_ms default 0");

// New config sections default sanely when absent.
assert.equal(cfg.proxy.readonlyToken, "", "readonly_token absent -> empty");
assert.equal(cfg.web.username, "", "web.username absent -> empty");
assert.equal(cfg.web.sessionSecret, "", "web.session_secret absent -> empty");
assert.deepEqual(cfg.audio.outputs, [], "audio.outputs absent -> []");
assert.equal(cfg.audio.snapcast, true, "audio.snapcast defaults on");
assert.deepEqual(cfg.overlay, DEFAULT_OVERLAY, "overlay absent -> defaults");

// `${VAR}` is no longer special — it is stored and returned verbatim.
const litPath = join(dir, "literal.yaml");
writeFileSync(litPath, ['soloist:', '  device_name: "d"', '  api_key: "${API}"', "  extra_args: []", "proxy:", '  token: "t"'].join("\n"));
assert.equal(loadConfig(litPath).soloist.apiKey, "${API}", "no interpolation: ${VAR} kept literal");

assert.throws(() => loadConfig(join(dir, "nope.yaml")), ConfigError, "missing file fails fast");

// saveConfig round-trips preserving comments and writes the new value.
cfg.soloist.deviceName = "Renamed Speaker";
cfg.audio.outputs = ["alsa_output.hw_0"];
cfg.overlay.fontSize = 72;
saveConfig(cfgPath, cfg);
const savedText = readFileSync(cfgPath, "utf8");
assert.match(savedText, /hand-written comment that must survive/, "block comment preserved");
assert.match(savedText, /inline note/, "inline comment preserved");
const reloaded = loadConfig(cfgPath);
assert.equal(reloaded.soloist.deviceName, "Renamed Speaker", "changed value persisted");
assert.deepEqual(reloaded.audio.outputs, ["alsa_output.hw_0"], "list persisted");
assert.equal(reloaded.overlay.fontSize, 72, "overlay value persisted");

// Atomic write leaves no temp file behind.
assert.deepEqual(
  readdirSync(dir).filter((f) => f.includes(".tmp-")),
  [],
  "no temp file left after save",
);

// saveConfig never persists an invalid config.
const before = readFileSync(cfgPath, "utf8");
const bad = loadConfig(cfgPath);
bad.soloist.apiKey = "";
assert.throws(() => saveConfig(cfgPath, bad), ConfigError, "invalid config rejected");
assert.equal(readFileSync(cfgPath, "utf8"), before, "file untouched after rejected save");

// ensureSecrets mints and persists absent secrets, then is idempotent.
const secretsCfg = loadConfig(cfgPath);
assert.equal(secretsCfg.web.sessionSecret, "", "precondition: no session_secret");
assert.equal(ensureSecrets(cfgPath, secretsCfg), true, "first boot writes secrets");
assert.notEqual(secretsCfg.web.sessionSecret, "", "session_secret generated");
assert.notEqual(secretsCfg.proxy.readonlyToken, "", "readonly_token generated");
const persisted = loadConfig(cfgPath);
assert.equal(persisted.web.sessionSecret, secretsCfg.web.sessionSecret, "session_secret persisted");
assert.equal(persisted.proxy.readonlyToken, secretsCfg.proxy.readonlyToken, "readonly_token persisted");
assert.equal(ensureSecrets(cfgPath, persisted), false, "already-set secrets: no rewrite");

// Config API: GET masks secrets, config-summary never leaks, PUT round-trips.
const sCfg = loadConfig(cfgPath);
sCfg.soloist.apiKey = "SECRET_API";
sCfg.proxy.token = "SECRET_TOK";
sCfg.proxy.readonlyToken = "SECRET_RO";
sCfg.webhooks.secret = "SECRET_WH";
sCfg.web.password = "SECRET_PW";
sCfg.web.sessionSecret = "SECRET_SESS";
const SECRETS = ["SECRET_API", "SECRET_TOK", "SECRET_RO", "SECRET_WH", "SECRET_PW", "SECRET_SESS"];

const maskedJson = JSON.stringify(maskConfig(sCfg));
for (const s of SECRETS) assert.ok(!maskedJson.includes(s), `maskConfig must not leak ${s}`);
const masked = maskConfig(sCfg) as any;
assert.equal(masked.soloist.apiKey, true, "set secret masks to true");
assert.equal(masked.proxy.readonlyToken, true, "set secret masks to true");
assert.equal(masked.soloist.deviceName, sCfg.soloist.deviceName, "non-secret preserved in mask");

const summaryJson = JSON.stringify(configSummary(sCfg));
for (const s of SECRETS) assert.ok(!summaryJson.includes(s), `configSummary must not leak ${s}`);
const summary = configSummary(sCfg) as any;
assert.equal(summary.secrets.apiKey, true, "summary flags set secret");
assert.equal(summary.deviceName, sCfg.soloist.deviceName, "summary reports device name");
assert.equal(summary.soloistWs, sCfg.soloistWs, "summary reports soloist_ws");
assert.equal(summary.wsUrl, `ws://${sCfg.soloistWs}`, "summary reports WS URL");
assert.equal((configSummary(loadConfig(cfgPath)) as any).secrets.webPassword, false, "unset secret flags false");

const applied = applyApiConfig(sCfg, {
  autoplay: true,
  proxy: { token: true, readonlyToken: "NEW_RO", listen: "9.9.9.9:1" },
  soloist: { apiKey: true, deviceName: "Renamed", dataDir: "/hacked" },
  web: { password: false, sessionSecret: "" },
});
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
assert.throws(() => applyApiConfig(sCfg, { soloist: { deviceName: "" } }), ConfigError, "invalid result rejected");

// webhooks.urls is a full-replace map: a dropped URL disappears (not merged).
const whCfgBase = loadConfig(cfgPath);
whCfgBase.webhooks.urls = { track_changed: "http://a", error: "http://b" };
const whApplied = applyApiConfig(whCfgBase, { webhooks: { urls: { track_changed: "http://a" } } });
assert.deepEqual(whApplied.webhooks.urls, { track_changed: "http://a" }, "removed webhook URL dropped from config");
// ...and the removal persists through saveConfig (mergeInto alone would keep it).
saveConfig(cfgPath, whApplied);
assert.deepEqual(loadConfig(cfgPath).webhooks.urls, { track_changed: "http://a" }, "webhook URL removal persisted to file");

// Web Session cookie: sign/verify round-trip, tamper rejection, fail-closed.
const SECRET = "sessionsecret";
const signed = signSession("admin", SECRET);
assert.equal(verifySession(signed, SECRET), "admin", "cookie round-trips the username");
assert.equal(verifySession(signed, "othersecret"), null, "wrong secret rejected");
assert.equal(verifySession(signed.slice(0, -1) + "x", SECRET), null, "tampered signature rejected");
assert.equal(verifySession(signed.replace("YWRtaW4", "cm9vdA"), SECRET), null, "tampered payload rejected");
assert.equal(verifySession("nodot", SECRET), null, "malformed cookie rejected");

assert.deepEqual(parseCookies("a=1; soloist_session=xyz"), { a: "1", soloist_session: "xyz" }, "cookie header parsed");
assert.deepEqual(parseCookies(undefined), {}, "no cookie header -> empty");

const webReq = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as IncomingMessage;
const webCfg = (u: string, p: string): Config => ({ web: { username: u, password: p, sessionSecret: SECRET } }) as unknown as Config;

assert.equal(webConfigured(webCfg("admin", "pw")), true, "creds set -> configured");
assert.equal(webConfigured(webCfg("", "")), false, "creds unset -> not configured");
assert.equal(webConfigured(webCfg("admin", "")), false, "half-set creds -> not configured");

const cfgSet = webCfg("admin", "pw");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", SECRET)}`), cfgSet), "admin", "valid cookie -> user");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", "wrong")}`), cfgSet), null, "bad-secret cookie -> null");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("mallory", SECRET)}`), cfgSet), null, "cookie for other user -> null");
assert.equal(sessionUser(webReq(), cfgSet), null, "no cookie -> null");
assert.equal(sessionUser(webReq(`${SESSION_COOKIE}=${signSession("admin", SECRET)}`), webCfg("", "")), null, "fail-closed: unset creds reject valid cookie");

// Hub read-only drop + state replay, against a real in-process upstream.
{
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
}

console.log("selftest OK");
