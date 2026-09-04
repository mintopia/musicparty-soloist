import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { parse as parseYaml, parseDocument, Document } from "yaml";

export const DEFAULT_CONFIG_PATH = "./config.yaml";
export const DEFAULT_PROXY_LISTEN = "0.0.0.0:8687";
export const DEFAULT_SOLOIST_WS = "127.0.0.1:3678";
export const DEFAULT_STREAM_NAME = "Spotify";
export const DEFAULT_DATA_DIR = "./.soloist-data";

export const DEFAULT_OVERLAY: OverlayConfig = {
  font: "system-ui, sans-serif",
  fontSize: 40,
  color: "#ffffff",
  neighbourColor: "#ffffff",
  dimOpacity: 0.35,
  motion: "slide",
  easing: "cubic-bezier(.16,1,.3,1)",
  transitionMs: 350,
  effect: "none",
  fxColor: "#ffd24a",
  fxIntensity: 50,
  fxDurMs: 1600,
  alignment: "center",
  anchor: "bottom",
  lineCount: 3,
  timingOffsetMs: 0,
};

export class ConfigError extends Error {}

// Web password storage: scrypt with a per-password random salt, encoded
// `scrypt$<saltHex>$<keyHex>`. The plaintext never touches disk. Pre-hashing
// installs stored cleartext; verifyPassword still accepts it (timing-safe) so a
// legacy config keeps working, and login rehashes it on first success.
const SCRYPT_KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(plain, salt, SCRYPT_KEYLEN).toString("hex")}`;
}

export function isPasswordHashed(stored: string): boolean {
  return stored.startsWith("scrypt$");
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (isPasswordHashed(stored)) {
    const [, saltHex, keyHex] = stored.split("$");
    if (!saltHex || !keyHex) return false;
    let expected: Buffer, got: Buffer;
    try {
      expected = Buffer.from(keyHex, "hex");
      got = scryptSync(plain, Buffer.from(saltHex, "hex"), expected.length);
    } catch {
      return false;
    }
    return expected.length === got.length && timingSafeEqual(got, expected);
  }
  // Legacy cleartext.
  const a = Buffer.from(plain), b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SoloistConfig {
  deviceName: string;
  apiKey: string;
  dataDir: string;
  extraArgs: string[];
  pipewireDevice: string;
}

export interface WebhooksConfig {
  defaultUrl: string;
  urls: Record<string, string>;
  secret: string;
  delayMs: number;
}

export interface WebConfig {
  username: string;
  password: string;
  sessionSecret: string;
}

export interface RelayConfig {
  url: string;           // ws://|wss:// Relay Server; empty = off
  authorization: string; // verbatim Authorization header on the outbound upgrade; empty = none
}

export interface AudioConfig {
  outputs: string[];
  snapcast: boolean;
}

export interface OverlayConfig {
  font: string;            // CSS font stack
  fontSize: number;        // px (1080p reference)
  color: string;           // current line
  neighbourColor: string;  // other lines
  dimOpacity: number;      // other-line opacity, 0..1
  motion: string;          // slide | crossfade | pop | instant
  easing: string;          // CSS timing function
  transitionMs: number;    // line-advance duration
  effect: string;          // none | glow | shimmer | rainbow | sparkles | wipe | neon | glitch | pulse
  fxColor: string;
  fxIntensity: number;     // 0..100
  fxDurMs: number;         // effect period
  alignment: string;       // left | center | right
  anchor: string;          // top | center | bottom
  lineCount: number;       // visible lines (odd)
  timingOffsetMs: number;
}

export interface Config {
  soloist: SoloistConfig;
  proxy: { listen: string; token: string; readonlyToken: string };
  soloistWs: string;
  streamName: string;
  autoplay: boolean;
  webhooks: WebhooksConfig;
  relay: RelayConfig;
  web: WebConfig;
  audio: AudioConfig;
  overlay: OverlayConfig;
}

export function coerceBool(value: unknown, def: boolean): boolean {
  if (value == null || value === "") return def;
  const s = String(value).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return def;
}

export function coerceInt(value: unknown, def: number): number {
  if (value == null || value === "") return def;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isNaN(n) ? def : n;
}

export function coerceFloat(value: unknown, def: number): number {
  if (value == null || value === "") return def;
  const n = Number.parseFloat(String(value).trim());
  return Number.isNaN(n) ? def : n;
}

function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("Config root must be a mapping");
  }
  const d = raw as Record<string, any>;

  const soloist = d.soloist ?? {};
  const proxy = d.proxy ?? {};
  const snapcast = d.snapcast ?? {};
  const webhooks = d.webhooks ?? {};
  const relay = d.relay ?? {};
  const web = d.web ?? {};
  const audio = d.audio ?? {};
  const overlay = d.overlay ?? {};

  const urlsRaw = webhooks.urls ?? {};
  if (typeof urlsRaw !== "object" || Array.isArray(urlsRaw)) {
    throw new ConfigError("webhooks.urls must be a mapping");
  }
  const urls: Record<string, string> = {};
  for (const [k, v] of Object.entries(urlsRaw)) urls[k] = String(v).trim();

  const extraArgs = soloist.extra_args ?? [];
  if (!Array.isArray(extraArgs)) {
    throw new ConfigError("soloist.extra_args must be a list");
  }

  const outputsRaw = audio.outputs ?? [];
  if (!Array.isArray(outputsRaw)) {
    throw new ConfigError("audio.outputs must be a list");
  }

  return {
    soloist: {
      // Optional at load so a fresh install boots into first-run setup mode with no
      // config; supervision is gated on presence via soloistReady (ADR-0009, T3).
      deviceName: String(soloist.device_name ?? "").trim(),
      apiKey: String(soloist.api_key ?? ""),
      dataDir: soloist.data_dir || DEFAULT_DATA_DIR,
      extraArgs: extraArgs.map((a: unknown) => String(a)),
      pipewireDevice: String(soloist.pipewire_device ?? "").trim(),
    },
    proxy: {
      listen: proxy.listen || DEFAULT_PROXY_LISTEN,
      token: String(proxy.token ?? "").trim(),
      readonlyToken: String(proxy.readonly_token ?? "").trim(),
    },
    soloistWs: d.soloist_ws || DEFAULT_SOLOIST_WS,
    streamName: snapcast.stream_name || DEFAULT_STREAM_NAME,
    autoplay: coerceBool(d.autoplay, false),
    webhooks: {
      defaultUrl: String(webhooks.default_url ?? "").trim(),
      urls,
      secret: String(webhooks.secret ?? ""),
      delayMs: coerceInt(webhooks.delay_ms, 0),
    },
    relay: {
      url: String(relay.url ?? "").trim(),
      authorization: String(relay.authorization ?? ""),
    },
    web: {
      username: String(web.username ?? "").trim(),
      password: String(web.password ?? ""),
      sessionSecret: String(web.session_secret ?? "").trim(),
    },
    audio: {
      outputs: outputsRaw.map((o: unknown) => String(o)),
      snapcast: coerceBool(audio.snapcast, true),
    },
    overlay: {
      font: String(overlay.font ?? DEFAULT_OVERLAY.font),
      fontSize: coerceInt(overlay.font_size, DEFAULT_OVERLAY.fontSize),
      color: String(overlay.color ?? DEFAULT_OVERLAY.color),
      neighbourColor: String(overlay.neighbour_color ?? DEFAULT_OVERLAY.neighbourColor),
      dimOpacity: coerceFloat(overlay.dim_opacity, DEFAULT_OVERLAY.dimOpacity),
      motion: String(overlay.motion ?? DEFAULT_OVERLAY.motion),
      easing: String(overlay.easing ?? DEFAULT_OVERLAY.easing),
      transitionMs: coerceInt(overlay.transition_ms, DEFAULT_OVERLAY.transitionMs),
      effect: String(overlay.effect ?? DEFAULT_OVERLAY.effect),
      fxColor: String(overlay.fx_color ?? DEFAULT_OVERLAY.fxColor),
      fxIntensity: coerceInt(overlay.fx_intensity, DEFAULT_OVERLAY.fxIntensity),
      fxDurMs: coerceInt(overlay.fx_dur_ms, DEFAULT_OVERLAY.fxDurMs),
      alignment: String(overlay.alignment ?? DEFAULT_OVERLAY.alignment),
      anchor: String(overlay.anchor ?? DEFAULT_OVERLAY.anchor),
      lineCount: coerceInt(overlay.line_count, DEFAULT_OVERLAY.lineCount),
      timingOffsetMs: coerceInt(overlay.timing_offset_ms, DEFAULT_OVERLAY.timingOffsetMs),
    },
  };
}

// Fully-defaulted Config for a fresh install with no config file — boots into
// first-run setup mode. Same shape/types as one read from disk.
export function defaultConfig(): Config {
  return parseConfig({});
}

// Soloist supervision may start only when web creds and the minimal Soloist args
// (device name + API key) are all present. Boot gate for first-run setup mode (T3).
export function soloistReady(cfg: Config): boolean {
  return (
    cfg.web.username !== "" &&
    cfg.web.password !== "" &&
    cfg.soloist.deviceName !== "" &&
    cfg.soloist.apiKey !== ""
  );
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  let text: string;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Config file not found: ${path}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`Invalid YAML in ${path}: ${(e as Error).message}`);
  }

  return parseConfig(raw ?? {});
}

// Snake_case YAML projection of a Config — the shape written to disk. Kept in
// one place so save validation and serialization agree with load.
function configToRaw(c: Config): Record<string, unknown> {
  return {
    soloist: {
      device_name: c.soloist.deviceName,
      api_key: c.soloist.apiKey,
      data_dir: c.soloist.dataDir,
      extra_args: c.soloist.extraArgs,
      pipewire_device: c.soloist.pipewireDevice,
    },
    proxy: {
      listen: c.proxy.listen,
      token: c.proxy.token,
      readonly_token: c.proxy.readonlyToken,
    },
    soloist_ws: c.soloistWs,
    snapcast: { stream_name: c.streamName },
    autoplay: c.autoplay,
    webhooks: {
      default_url: c.webhooks.defaultUrl,
      urls: c.webhooks.urls,
      secret: c.webhooks.secret,
      delay_ms: c.webhooks.delayMs,
    },
    relay: {
      url: c.relay.url,
      authorization: c.relay.authorization,
    },
    web: {
      username: c.web.username,
      password: c.web.password,
      session_secret: c.web.sessionSecret,
    },
    audio: {
      outputs: c.audio.outputs,
      snapcast: c.audio.snapcast,
    },
    overlay: {
      font: c.overlay.font,
      font_size: c.overlay.fontSize,
      color: c.overlay.color,
      neighbour_color: c.overlay.neighbourColor,
      dim_opacity: c.overlay.dimOpacity,
      motion: c.overlay.motion,
      easing: c.overlay.easing,
      transition_ms: c.overlay.transitionMs,
      effect: c.overlay.effect,
      fx_color: c.overlay.fxColor,
      fx_intensity: c.overlay.fxIntensity,
      fx_dur_ms: c.overlay.fxDurMs,
      alignment: c.overlay.alignment,
      anchor: c.overlay.anchor,
      line_count: c.overlay.lineCount,
      timing_offset_ms: c.overlay.timingOffsetMs,
    },
  };
}

// Set every leaf of `obj` onto the Document via setIn, so comments and layout on
// untouched nodes survive the round-trip.
// ponytail: merge only sets keys, never removes them — a key deleted from the
// config object stays in the file. Fine for full-config writes; revisit if the
// config API needs to drop keys (e.g. removing a webhooks.urls entry).
function mergeInto(doc: Document, obj: Record<string, unknown>, prefix: string[] = []): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...prefix, k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      mergeInto(doc, v as Record<string, unknown>, path);
    } else {
      doc.setIn(path, v);
    }
  }
}

export function saveConfig(path: string, config: Config): void {
  const raw = configToRaw(config);
  parseConfig(raw); // same required/type checks as load; throws before any write

  let doc: Document | null = null;
  try {
    const parsed = parseDocument(readFileSync(path, "utf8"));
    if (parsed.errors.length === 0 && parsed.contents != null) doc = parsed;
  } catch {
    // no existing file (or unreadable/corrupt) — start fresh, no comments to keep
  }
  if (doc) {
    mergeInto(doc, raw);
    // mergeInto never removes keys, so a webhook URL dropped from the config would
    // linger in the file. urls is a plain map — replace the whole node so removals
    // persist (round-trips fine; entries are `name: url`, not comment-bearing).
    doc.setIn(["webhooks", "urls"], (raw.webhooks as Record<string, unknown>).urls);
  } else {
    doc = new Document(raw);
  }

  const text = String(doc);
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

// Secret leaves never rendered to the browser — one source of truth for masking
// (GET), the summary flags, and PUT preservation. `label` is the summary key.
// GET masks each to a set/unset boolean; PUT keeps the stored value unless a
// fresh non-empty string is sent.
export const SECRETS: { section: string; key: string; label: string }[] = [
  { section: "soloist", key: "apiKey", label: "apiKey" },
  { section: "proxy", key: "token", label: "authToken" },
  { section: "proxy", key: "readonlyToken", label: "readonlyToken" },
  { section: "webhooks", key: "secret", label: "webhooksSecret" },
  { section: "relay", key: "authorization", label: "relayAuthorization" },
  { section: "web", key: "password", label: "webPassword" },
  { section: "web", key: "sessionSecret", label: "sessionSecret" },
];

// Structural fields the Landing Page shows read-only (lockout / footguns, ADR-0010).
// PUT can never change them — they stay hand-edit-only.
const LOCKED_PATHS: [string, string][] = [
  ["proxy", "listen"],
  ["soloist", "extraArgs"],
  ["soloist", "dataDir"],
];

function isSet(v: unknown): boolean {
  return String(v ?? "") !== "";
}

// Whole config for GET /api/config, secret leaves replaced by set/unset booleans.
export function maskConfig(cfg: Config): Record<string, unknown> {
  const clone = structuredClone(cfg) as Record<string, any>;
  for (const { section, key } of SECRETS) clone[section][key] = isSet((cfg as any)[section][key]);
  return clone;
}

// Display-plane view for GET /api/config-summary. Only per-secret set/unset flags,
// never a secret value.
export function configSummary(cfg: Config): Record<string, unknown> {
  const secrets: Record<string, boolean> = {};
  for (const { section, key, label } of SECRETS) secrets[label] = isSet((cfg as any)[section][key]);
  return {
    deviceName: cfg.soloist.deviceName,
    soloistWs: cfg.soloistWs,
    wsUrl: `ws://${cfg.soloistWs}`,
    autoplay: cfg.autoplay,
    streamName: cfg.streamName,
    secrets,
  };
}

// Re-coerce and re-validate a Config through the same path load uses, so a config
// assembled in memory has identical types/defaults to one read from disk.
export function normalizeConfig(c: Config): Config {
  return parseConfig(configToRaw(c));
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
  for (const [k, v] of Object.entries(source)) {
    const t = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && t && typeof t === "object" && !Array.isArray(t)) {
      deepMerge(t, v);
    } else {
      target[k] = v;
    }
  }
}

// Build the next Config from a PUT body (masked-config shape). Absent fields keep
// current values; masked secrets keep the stored value; locked fields are pinned.
// Throws ConfigError on an invalid result.
export function applyApiConfig(current: Config, body: unknown): Config {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConfigError("Config body must be a mapping");
  }
  const next = structuredClone(current) as Record<string, any>;
  deepMerge(next, body as Record<string, any>);
  const b = body as Record<string, any>;
  // webhooks.urls is a full-replace map: a URL the client dropped must disappear,
  // but deepMerge only adds/overwrites keys — so take the body's map wholesale.
  if (b.webhooks?.urls && typeof b.webhooks.urls === "object" && !Array.isArray(b.webhooks.urls)) {
    next.webhooks.urls = b.webhooks.urls;
  }
  for (const { section, key } of SECRETS) {
    const v = b[section]?.[key];
    if (typeof v === "string" && v !== "") {
      // web.password arrives as plaintext (Replace flow) — hash before it persists.
      next[section][key] = section === "web" && key === "password" ? hashPassword(v) : v;
    } else {
      next[section][key] = (current as any)[section][key];
    }
  }
  for (const [s, k] of LOCKED_PATHS) next[s][k] = (current as any)[s][k];
  return normalizeConfig(next as Config);
}

// On boot, mint any absent autogenerated secret and persist it so it survives
// restarts. Returns whether the file was written.
export function ensureSecrets(path: string, config: Config): boolean {
  let changed = false;
  if (!config.web.sessionSecret) {
    config.web.sessionSecret = randomBytes(32).toString("hex");
    changed = true;
  }
  if (!config.proxy.token) {
    config.proxy.token = randomBytes(32).toString("hex");
    changed = true;
  }
  if (!config.proxy.readonlyToken) {
    config.proxy.readonlyToken = randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) saveConfig(path, config);
  return changed;
}
