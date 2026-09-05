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

// Docker-only snapserver.conf template (ADR-0020). {{stream}} expands to the pipewire
// capture source line (derived from streamName), {{snapweb}} to the Snapweb enable flag
// (true/false). Operator-editable in Settings; rendered by src/snapserver.ts.
export const DEFAULT_SNAPSERVER_CONFIG = `[stream]
{{stream}}

[http]
enabled = {{snapweb}}
bind_to_address = 0.0.0.0
port = 1780
doc_root = /usr/share/snapserver/snapweb
`;
export const MAX_OUTPUT_DELAY_MS = 5000;

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
  outputDelays: Record<string, number>; // node.name -> ms, hardware sinks only; 0/absent = none
}

export const OVERLAY_MOTIONS = ["slide", "crossfade", "pop", "instant"] as const;
export const OVERLAY_EFFECTS = ["none", "glow", "shimmer", "rainbow", "sparkles", "wipe", "neon", "glitch", "pulse"] as const;
export const OVERLAY_ALIGNMENTS = ["left", "center", "right"] as const;
export const OVERLAY_ANCHORS = ["top", "center", "bottom"] as const;

export interface OverlayConfig {
  font: string;            // CSS font stack
  fontSize: number;        // px (1080p reference)
  color: string;           // current line
  neighbourColor: string;  // other lines
  dimOpacity: number;      // other-line opacity, 0..1
  motion: (typeof OVERLAY_MOTIONS)[number];
  easing: string;          // CSS timing function
  transitionMs: number;    // line-advance duration
  effect: (typeof OVERLAY_EFFECTS)[number];
  fxColor: string;
  fxIntensity: number;     // 0..100
  fxDurMs: number;         // effect period
  alignment: (typeof OVERLAY_ALIGNMENTS)[number];
  anchor: (typeof OVERLAY_ANCHORS)[number];
  lineCount: number;       // visible lines (odd)
  timingOffsetMs: number;
}

// The running process holds exactly one Config object; live-apply consumers (auth,
// sessionUser, webhooks, autoplay, overlay, relay) read it by reference. A save MUST
// mutate this object in place (Object.assign) and MUST NEVER reassign the reference,
// or those consumers keep reading the stale object. How each field takes effect is
// declared in APPLY_STRATEGY (ADR-0022).
export interface Config {
  soloist: SoloistConfig;
  proxy: { listen: string; token: string; readonlyToken: string };
  soloistWs: string;
  streamName: string;
  snapweb: boolean;              // Docker only: serve the Snapweb UI ([http] enabled in snapserver.conf)
  snapcastServerConfig: string; // Docker only: snapserver.conf template ({{stream}}, {{snapweb}} placeholders)
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

const enumField =
  <T extends string>(allowed: readonly T[]) =>
  (v: unknown, def: T): T =>
    allowed.includes(String(v) as T) ? (String(v) as T) : def;

// Overlay fields are ~1:1 scalar mappings (camelCase key <-> snake_case yaml key,
// a default, a coercer) — one table drives DEFAULT_OVERLAY, parseConfig, and
// configToRaw instead of hand-restating each field three times (mirrors SECRETS below).
interface OverlayFieldDef<K extends keyof OverlayConfig> {
  key: K;
  yaml: string;
  default: OverlayConfig[K];
  coerce: (raw: unknown, def: OverlayConfig[K]) => OverlayConfig[K];
}

// Identity helper so each array entry keeps its own K instead of widening to the
// union of every OverlayConfig key when collected into OVERLAY_FIELDS below.
const overlayField = <K extends keyof OverlayConfig>(f: OverlayFieldDef<K>): OverlayFieldDef<K> => f;

type AnyOverlayFieldDef = { [K in keyof OverlayConfig]: OverlayFieldDef<K> }[keyof OverlayConfig];

const OVERLAY_FIELDS: AnyOverlayFieldDef[] = [
  overlayField({ key: "font", yaml: "font", default: "system-ui, sans-serif", coerce: stringField }),
  overlayField({ key: "fontSize", yaml: "font_size", default: 40, coerce: coerceInt }),
  overlayField({ key: "color", yaml: "color", default: "#ffffff", coerce: stringField }),
  overlayField({ key: "neighbourColor", yaml: "neighbour_color", default: "#ffffff", coerce: stringField }),
  overlayField({ key: "dimOpacity", yaml: "dim_opacity", default: 0.35, coerce: coerceFloat }),
  overlayField({ key: "motion", yaml: "motion", default: "slide", coerce: enumField(OVERLAY_MOTIONS) }),
  overlayField({ key: "easing", yaml: "easing", default: "cubic-bezier(.16,1,.3,1)", coerce: stringField }),
  overlayField({ key: "transitionMs", yaml: "transition_ms", default: 350, coerce: coerceInt }),
  overlayField({ key: "effect", yaml: "effect", default: "none", coerce: enumField(OVERLAY_EFFECTS) }),
  overlayField({ key: "fxColor", yaml: "fx_color", default: "#ffd24a", coerce: stringField }),
  overlayField({ key: "fxIntensity", yaml: "fx_intensity", default: 50, coerce: coerceInt }),
  overlayField({ key: "fxDurMs", yaml: "fx_dur_ms", default: 1600, coerce: coerceInt }),
  overlayField({ key: "alignment", yaml: "alignment", default: "center", coerce: enumField(OVERLAY_ALIGNMENTS) }),
  overlayField({ key: "anchor", yaml: "anchor", default: "bottom", coerce: enumField(OVERLAY_ANCHORS) }),
  overlayField({ key: "lineCount", yaml: "line_count", default: 3, coerce: coerceInt }),
  overlayField({ key: "timingOffsetMs", yaml: "timing_offset_ms", default: 0, coerce: coerceInt }),
];

export const DEFAULT_OVERLAY: OverlayConfig = Object.fromEntries(
  OVERLAY_FIELDS.map((f) => [f.key, f.default]),
) as unknown as OverlayConfig;

// ── Apply strategy (ADR-0022) ────────────────────────────────────────────────
// How each config field takes effect after a save. Single source of truth: the
// `satisfies Record<keyof …>` lines make TypeScript reject any section that adds a
// field without classifying it, so a new field can no longer silently fail to apply.
//
//   live             read live off the shared Config; mutating it in place (never
//                    reassigning — see the Config contract) is the whole apply step.
//   callback         needs the post-save onConfigChange callback to push/re-dial:
//                    overlay broadcast, relay re-connect, PipeWire fan-out reconcile.
//   restart-soloist  a Soloist spawn arg (buildArgv); applies only when Soloist
//                    re-spawns. The "restart Soloist" banner (pendingRestart) offers it.
//   restart-snapcast feeds renderSnapserverConf; applies only when snapserver restarts.
//                    The "restart Snapcast" banner (snapcastNeedsRestart) offers it.
//   restart-process  a locked structural field (hand-edit-only, LOCKED_PATHS); needs a
//                    full process restart. No banner — PUT can never change it live.
export type ApplyStrategy =
  | "live"
  | "callback"
  | "restart-soloist"
  | "restart-snapcast"
  | "restart-process";

export const APPLY_STRATEGY = {
  soloist: {
    deviceName: "restart-soloist",
    apiKey: "restart-soloist",
    dataDir: "restart-soloist",
    extraArgs: "restart-soloist",
    pipewireDevice: "restart-soloist",
  } satisfies Record<keyof SoloistConfig, ApplyStrategy>,
  proxy: {
    listen: "restart-process",
    token: "live",
    readonlyToken: "live",
  } satisfies Record<keyof Config["proxy"], ApplyStrategy>,
  soloistWs: "restart-soloist",
  streamName: "restart-snapcast",
  snapweb: "restart-snapcast",
  snapcastServerConfig: "restart-snapcast",
  autoplay: "live",
  webhooks: {
    defaultUrl: "live",
    urls: "live",
    secret: "live",
    delayMs: "live",
  } satisfies Record<keyof WebhooksConfig, ApplyStrategy>,
  relay: {
    url: "callback",
    authorization: "callback",
  } satisfies Record<keyof RelayConfig, ApplyStrategy>,
  web: {
    username: "live",
    password: "live",
    sessionSecret: "live",
  } satisfies Record<keyof WebConfig, ApplyStrategy>,
  audio: {
    outputs: "callback",
    snapcast: "callback",
    outputDelays: "callback",
  } satisfies Record<keyof AudioConfig, ApplyStrategy>,
  // Every overlay field is callback: a save broadcasts overlay_config so open overlays
  // restyle without a reload (new page loads read the values live). Spelled out rather
  // than derived so the satisfies check forces a strategy for any field added here too.
  overlay: {
    font: "callback",
    fontSize: "callback",
    color: "callback",
    neighbourColor: "callback",
    dimOpacity: "callback",
    motion: "callback",
    easing: "callback",
    transitionMs: "callback",
    effect: "callback",
    fxColor: "callback",
    fxIntensity: "callback",
    fxDurMs: "callback",
    alignment: "callback",
    anchor: "callback",
    lineCount: "callback",
    timingOffsetMs: "callback",
  } satisfies Record<keyof OverlayConfig, ApplyStrategy>,
} satisfies Record<keyof Config, ApplyStrategy | Record<string, ApplyStrategy>>;

function parseOverlay(raw: Record<string, any>): OverlayConfig {
  const out: Record<string, unknown> = {};
  // TS can't correlate a heterogeneous union's own coerce/default across elements
  // (see AnyOverlayFieldDef); each element is internally consistent, so this is safe.
  for (const f of OVERLAY_FIELDS) out[f.key] = (f.coerce as (raw: unknown, def: unknown) => unknown)(raw[f.yaml], f.default);
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

  const outputDelaysRaw = audio.output_delays ?? {};
  if (typeof outputDelaysRaw !== "object" || Array.isArray(outputDelaysRaw)) {
    throw new ConfigError("audio.output_delays must be a mapping");
  }
  const outputDelays: Record<string, number> = {};
  for (const [k, v] of Object.entries(outputDelaysRaw)) {
    outputDelays[k] = Math.min(MAX_OUTPUT_DELAY_MS, Math.max(0, coerceInt(v, 0)));
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
    snapweb: coerceBool(snapcast.snapweb, true),
    snapcastServerConfig: String(snapcast.server_config ?? "") || DEFAULT_SNAPSERVER_CONFIG,
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
      outputDelays,
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
    snapcast: { stream_name: c.streamName, snapweb: c.snapweb, server_config: c.snapcastServerConfig },
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
      output_delays: c.audio.outputDelays,
    },
    overlay: overlayToRaw(c.overlay),
  };
}

// Set every leaf of `obj` onto the Document via setIn, so comments and layout on
// untouched nodes survive the round-trip.
// ponytail: merge only sets keys, never removes them — a key deleted from the
// config object stays in the file. Fine for full-config writes; revisit if the
// config API needs to drop keys (e.g. removing a webhooks.urls entry).
// The YAML-Document merge (vs deepMerge below for plain objects); setIn writes into
// the yaml AST, not a JS object, so it needs no __proto__ guard.
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
    snapweb: cfg.snapweb,
    secrets,
  };
}

export function normalizeConfig(c: Config): Config {
  return parseConfig(configToRaw(c));
}

// The plain-object merge (vs mergeInto above for a YAML Document); needs the
// __proto__ guard below because bracket-assigning it here writes a real JS object.
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
