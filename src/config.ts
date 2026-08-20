import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export const DEFAULT_CONFIG_PATH = "./config.yaml";
export const DEFAULT_PROXY_LISTEN = "0.0.0.0:8687";
export const DEFAULT_SOLOIST_WS = "127.0.0.1:3678";
export const DEFAULT_STREAM_NAME = "Spotify";
export const DEFAULT_DATA_DIR = "./.soloist-data";

// matches ${VAR} and ${VAR:-default}
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

export interface SoloistConfig {
  deviceName: string;
  apiKey: string;
  dataDir: string;
  extraArgs: string[];
  pipewireDevice: string;
}

export interface Config {
  soloist: SoloistConfig;
  proxy: { listen: string; token: string };
  soloistWs: string;
  streamName: string;
}

function resolve(env: Env, name: string, def: string | undefined): string {
  const val = env[name];
  if (val) return val;
  return def ?? "";
}

function interpolate(value: unknown, env: Env): unknown {
  if (typeof value === "string") {
    return value.replace(VAR_RE, (_m, name, def) => resolve(env, name, def));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env);
    return out;
  }
  return value;
}

// env and ${VAR} interpolation only ever yield strings; these coerce to the
// intended type, falling back to `def` for unset/empty/unrecognized values.
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

export function loadConfig(path?: string, env: Env = process.env): Config {
  const resolved = path || env.SOLOIST_PROXY_CONFIG || DEFAULT_CONFIG_PATH;
  let text: string;
  try {
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    text = readFileSync(resolved, "utf8");
  } catch {
    throw new ConfigError(`Config file not found: ${resolved}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`Invalid YAML in ${resolved}: ${(e as Error).message}`);
  }

  const data = interpolate(raw ?? {}, env);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError("Config root must be a mapping");
  }
  const d = data as Record<string, any>;

  const soloist = d.soloist ?? {};
  const proxy = d.proxy ?? {};
  const snapcast = d.snapcast ?? {};

  const extraArgs = soloist.extra_args ?? [];
  if (!Array.isArray(extraArgs)) {
    throw new ConfigError("soloist.extra_args must be a list");
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
    },
    soloistWs: d.soloist_ws || DEFAULT_SOLOIST_WS,
    streamName: snapcast.stream_name || DEFAULT_STREAM_NAME,
  };
}
