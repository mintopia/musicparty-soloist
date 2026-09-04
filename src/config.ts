import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { parse as parseYaml, parseDocument, Document } from "yaml";
import { safeStrEqual } from "./util.js";

export const DEFAULT_CONFIG_PATH = "./config.yaml";
export const DEFAULT_PROXY_LISTEN = "0.0.0.0:8687";
export const DEFAULT_SOLOIST_WS = "127.0.0.1:3678";
export const DEFAULT_STREAM_NAME = "Spotify";
export const DEFAULT_DATA_DIR = "./.soloist-data";

export class ConfigError extends Error {}

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
  return verifyLegacyCleartext(plain, stored);
}

function verifyLegacyCleartext(plain: string, stored: string): boolean {
  return safeStrEqual(plain, stored);
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

function stringField(v: unknown, def: string): string {
  return String(v ?? def);
}

// Overlay fields are ~1:1 scalar mappings (camelCase key <-> snake_case yaml key,
// a default, a coercer) — one table drives DEFAULT_OVERLAY, parseConfig, and
// configToRaw instead of hand-restating each field three times (mirrors SECRETS below).
interface OverlayFieldDef {
  key: keyof OverlayConfig;
  yaml: string;
  default: unknown;
  coerce: (raw: unknown, def: any) => any;
}

const OVERLAY_FIELDS: OverlayFieldDef[] = [
  { key: "font", yaml: "font", default: "system-ui, sans-serif", coerce: stringField },
  { key: "fontSize", yaml: "font_size", default: 40, coerce: coerceInt },
  { key: "color", yaml: "color", default: "#ffffff", coerce: stringField },
  { key: "neighbourColor", yaml: "neighbour_color", default: "#ffffff", coerce: stringField },
  { key: "dimOpacity", yaml: "dim_opacity", default: 0.35, coerce: coerceFloat },
  { key: "motion", yaml: "motion", default: "slide", coerce: stringField },
  { key: "easing", yaml: "easing", default: "cubic-bezier(.16,1,.3,1)", coerce: stringField },
  { key: "transitionMs", yaml: "transition_ms", default: 350, coerce: coerceInt },
  { key: "effect", yaml: "effect", default: "none", coerce: stringField },
  { key: "fxColor", yaml: "fx_color", default: "#ffd24a", coerce: stringField },
  { key: "fxIntensity", yaml: "fx_intensity", default: 50, coerce: coerceInt },
  { key: "fxDurMs", yaml: "fx_dur_ms", default: 1600, coerce: coerceInt },
  { key: "alignment", yaml: "alignment", default: "center", coerce: stringField },
  { key: "anchor", yaml: "anchor", default: "bottom", coerce: stringField },
  { key: "lineCount", yaml: "line_count", default: 3, coerce: coerceInt },
  { key: "timingOffsetMs", yaml: "timing_offset_ms", default: 0, coerce: coerceInt },
];

export const DEFAULT_OVERLAY: OverlayConfig = Object.fromEntries(
  OVERLAY_FIELDS.map((f) => [f.key, f.default]),
) as unknown as OverlayConfig;

function parseOverlay(raw: Record<string, any>): OverlayConfig {
  const out: Record<string, unknown> = {};
  for (const f of OVERLAY_FIELDS) out[f.key] = f.coerce(raw[f.yaml], f.default);
  return out as unknown as OverlayConfig;
}

function overlayToRaw(o: OverlayConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of OVERLAY_FIELDS) out[f.yaml] = (o as unknown as Record<string, unknown>)[f.key];
  return out;
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
    overlay: parseOverlay(overlay),
  };
}

export function defaultConfig(): Config {
  return parseConfig({});
}

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
    overlay: overlayToRaw(c.overlay),
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
    // mergeInto only adds keys; replace the urls map wholesale so a dropped webhook disappears.
    doc.setIn(["webhooks", "urls"], (raw.webhooks as Record<string, unknown>).urls);
  } else {
    doc = new Document(raw);
  }

  const text = String(doc);
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

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

export function maskConfig(cfg: Config): Record<string, unknown> {
  const clone = structuredClone(cfg) as Record<string, any>;
  for (const { section, key } of SECRETS) clone[section][key] = isSet((cfg as any)[section][key]);
  return clone;
}

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

export function normalizeConfig(c: Config): Config {
  return parseConfig(configToRaw(c));
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
  for (const [k, v] of Object.entries(source)) {
    // JSON.parse gives "__proto__" as a real own key; bracket-assigning it would
    // pollute Object.prototype for every object in the process.
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
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
  // deepMerge only adds/overwrites; take the body's urls map wholesale so a dropped webhook disappears.
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
