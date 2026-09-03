import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml, parseDocument, Document } from "yaml";

export const DEFAULT_CONFIG_PATH = "./config.yaml";
export const DEFAULT_PROXY_LISTEN = "0.0.0.0:8687";
export const DEFAULT_SOLOIST_WS = "127.0.0.1:3678";
export const DEFAULT_STREAM_NAME = "Spotify";
export const DEFAULT_DATA_DIR = "./.soloist-data";

export const DEFAULT_OVERLAY: OverlayConfig = {
  font: "sans-serif",
  fontSize: 48,
  color: "#ffffff",
  highlightColor: "#1db954",
  effect: "fade",
  alignment: "center",
  timingOffsetMs: 0,
  lineCount: 3,
  anchor: "bottom",
};

export class ConfigError extends Error {}

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

export interface AudioConfig {
  outputs: string[];
  snapcast: boolean;
}

export interface OverlayConfig {
  font: string;
  fontSize: number;
  color: string;
  highlightColor: string;
  effect: string;
  alignment: string;
  timingOffsetMs: number;
  lineCount: number;
  anchor: string;
}

export interface Config {
  soloist: SoloistConfig;
  proxy: { listen: string; token: string; readonlyToken: string };
  soloistWs: string;
  streamName: string;
  autoplay: boolean;
  webhooks: WebhooksConfig;
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

function required(value: unknown, name: string): string {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    throw new ConfigError(`Missing required config value: ${name}`);
  }
  return String(value);
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
      deviceName: required(soloist.device_name, "soloist.device_name (device name)"),
      apiKey: required(soloist.api_key, "soloist.api_key (Spotify API Key)"),
      dataDir: soloist.data_dir || DEFAULT_DATA_DIR,
      extraArgs: extraArgs.map((a: unknown) => String(a)),
      pipewireDevice: String(soloist.pipewire_device ?? "").trim(),
    },
    proxy: {
      listen: proxy.listen || DEFAULT_PROXY_LISTEN,
      token: required(proxy.token, "proxy.token (Auth Token)"),
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
      highlightColor: String(overlay.highlight_color ?? DEFAULT_OVERLAY.highlightColor),
      effect: String(overlay.effect ?? DEFAULT_OVERLAY.effect),
      alignment: String(overlay.alignment ?? DEFAULT_OVERLAY.alignment),
      timingOffsetMs: coerceInt(overlay.timing_offset_ms, DEFAULT_OVERLAY.timingOffsetMs),
      lineCount: coerceInt(overlay.line_count, DEFAULT_OVERLAY.lineCount),
      anchor: String(overlay.anchor ?? DEFAULT_OVERLAY.anchor),
    },
  };
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
      highlight_color: c.overlay.highlightColor,
      effect: c.overlay.effect,
      alignment: c.overlay.alignment,
      timing_offset_ms: c.overlay.timingOffsetMs,
      line_count: c.overlay.lineCount,
      anchor: c.overlay.anchor,
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
    next[section][key] = typeof v === "string" && v !== "" ? v : (current as any)[section][key];
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
  if (!config.proxy.readonlyToken) {
    config.proxy.readonlyToken = randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) saveConfig(path, config);
  return changed;
}
