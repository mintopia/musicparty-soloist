import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { detectArch, AcquisitionError, tarballUrl } from "./acquire.js";
import { checkAuth, decodeFrame, shouldAutoplay, resolveWebhookUrl, WebhookQueue, AUTOPLAY_FRAMES, type UpstreamFrame } from "./proxy.js";
import type { RawData } from "ws";
import { loadConfig, saveConfig, ensureSecrets, ConfigError, coerceBool, coerceInt, DEFAULT_OVERLAY } from "./config.js";

function req(headers: Record<string, string>, url = "/"): IncomingMessage {
  return { headers, url, socket: { remoteAddress: "test" } } as unknown as IncomingMessage;
}

assert.equal(detectArch("x64"), "x86_64");
assert.equal(detectArch("arm64"), "arm64");
assert.equal(detectArch("arm"), "arm32");
assert.throws(() => detectArch("sparc"), AcquisitionError);
assert.equal(tarballUrl("arm64", "https://x/y/"), "https://x/y/soloist_release_arm64.tar.gz");

const T = "s3cret";
assert.equal(checkAuth(req({ authorization: `Bearer ${T}` }), T), true, "good bearer passes");
assert.equal(checkAuth(req({}, `/?token=${T}`), T), true, "good query token passes");
assert.equal(checkAuth(req({ authorization: "Bearer nope" }), T), false, "bad token rejected");
assert.equal(checkAuth(req({}), T), false, "missing token rejected");
assert.equal(checkAuth(req({ authorization: "Bearer " + T + "x" }), T), false, "wrong length rejected");

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

console.log("selftest OK");
