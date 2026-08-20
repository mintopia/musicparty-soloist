// Config loader for the Soloist Proxy.
//
// Reads the YAML Config File, resolves ${VAR} / ${VAR:-default} references from
// the environment (env wins over any file-provided default), applies defaults,
// and validates the required secrets. Missing required values fail fast.

import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export const DEFAULT_CONFIG_PATH = "./config.yaml";
export const DEFAULT_PROXY_LISTEN = "0.0.0.0:8687";
export const DEFAULT_SOLOIST_WS = "127.0.0.1:3678";
export const DEFAULT_STREAM_NAME = "Spotify";
export const DEFAULT_DATA_DIR = "./.soloist-data";

// ${VAR} or ${VAR:-default}
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

export interface SoloistConfig {
  deviceName: string;
  apiKey: string;
  dataDir: string;
  extraArgs: string[];
  pipewireDevice: string; // Docker-only: null-sink to play into; empty = omit the flag
}

export interface Config {
  soloist: SoloistConfig;
  proxy: { listen: string; token: string };
  soloistWs: string;
  streamName: string; // Docker-only; the standalone ignores it
}

function resolve(env: Env, name: string, def: string | undefined): string {
  const val = env[name];
  if (val) return val; // env wins; unset or empty falls back to the file default
  return def ?? "";
}

// Recursively substitute ${VAR}/${VAR:-default} in every string.
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
