import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { detectArch, AcquisitionError, tarballUrl } from "./acquire.js";
import { checkAuth, decodeFrame } from "./proxy.js";
import type { RawData } from "ws";
import { loadConfig, ConfigError, coerceBool, coerceInt } from "./config.js";

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

const dir = mkdtempSync(join(tmpdir(), "cfgtest-"));
const cfgPath = join(dir, "config.yaml");
writeFileSync(
  cfgPath,
  [
    "soloist:",
    '  device_name: "${DEV:-Party Speaker}"',
    '  api_key: "${API}"',
    "  extra_args: []",
    "proxy:",
    '  listen: "${LISTEN:-0.0.0.0:8687}"',
    '  token: "${TOK}"',
  ].join("\n"),
);

const cfg = loadConfig(cfgPath, { API: "key123", TOK: "tok123", LISTEN: "127.0.0.1:9000" });
assert.equal(cfg.soloist.deviceName, "Party Speaker", "default used when var unset");
assert.equal(cfg.soloist.apiKey, "key123", "interpolated from env");
assert.equal(cfg.proxy.token, "tok123");
assert.equal(cfg.proxy.listen, "127.0.0.1:9000", "env value wins over ${:-default}");

assert.throws(() => loadConfig(cfgPath, { TOK: "t" }), ConfigError, "missing api_key fails fast");

console.log("selftest OK");
