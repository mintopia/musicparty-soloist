"""Config loader for the Soloist Proxy.

Reads the YAML Config File, resolves ``${VAR}`` / ``${VAR:-default}`` references
from the environment (env wins over any file-provided default), applies sensible
defaults, and validates the required secrets. Missing required values fail fast.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_CONFIG_PATH = "./config.yaml"
DEFAULT_PROXY_LISTEN = "0.0.0.0:8687"
DEFAULT_SOLOIST_WS = "127.0.0.1:3678"
DEFAULT_STREAM_NAME = "Spotify"
DEFAULT_DATA_DIR = "./.soloist-data"

# ${VAR} or ${VAR:-default}
_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")

# Direct env overrides: any value is env-overridable, even a plain file literal.
# env var -> path into the config mapping. Env wins over the file.
_ENV_OVERRIDES = {
    "SOLOIST_DEVICE_NAME": ("soloist", "device_name"),
    "SOLOIST_API_KEY": ("soloist", "api_key"),
    "SOLOIST_DATA_DIR": ("soloist", "data_dir"),
    "SOLOIST_PIPEWIRE_DEVICE": ("soloist", "pipewire_device"),
    "PROXY_LISTEN": ("proxy", "listen"),
    "PROXY_TOKEN": ("proxy", "token"),
    "SOLOIST_WS": ("soloist_ws",),
    "SNAPCAST_STREAM": ("snapcast", "stream_name"),
}


class ConfigError(Exception):
    """Configuration is missing or invalid."""


@dataclass
class SoloistConfig:
    device_name: str
    api_key: str
    data_dir: str
    extra_args: list[str] = field(default_factory=list)
    pipewire_device: str = ""  # Docker-only: null-sink to play into; empty = omit the flag


@dataclass
class ProxyConfig:
    listen: str
    token: str


@dataclass
class Config:
    soloist: SoloistConfig
    proxy: ProxyConfig
    soloist_ws: str
    stream_name: str  # Docker-only; the standalone script ignores it


def _interpolate(value, env):
    """Recursively substitute ${VAR}/${VAR:-default} in every string."""
    if isinstance(value, str):
        return _VAR_RE.sub(lambda m: _resolve(m, env), value)
    if isinstance(value, list):
        return [_interpolate(v, env) for v in value]
    if isinstance(value, dict):
        return {k: _interpolate(v, env) for k, v in value.items()}
    return value


def _resolve(match, env):
    var, default = match.group(1), match.group(2)
    val = env.get(var)
    if val:  # env wins; unset or empty falls back to the file default
        return val
    return default if default is not None else ""


def _apply_env_overrides(data, env):
    """Overlay direct env overrides onto the file mapping; env wins."""
    for var, path in _ENV_OVERRIDES.items():
        val = env.get(var)
        if not val:  # unset or empty leaves the file value in place
            continue
        d = data
        for key in path[:-1]:
            nxt = d.get(key)
            if not isinstance(nxt, dict):
                nxt = {}
                d[key] = nxt
            d = nxt
        d[path[-1]] = val
    return data


def _require(value, name):
    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise ConfigError(f"Missing required config value: {name}")
    return value


def load_config(path: str | None = None, env=None) -> Config:
    """Load config from ``path`` (or $SOLOIST_PROXY_CONFIG, or ./config.yaml)."""
    env = os.environ if env is None else env
    resolved = path or env.get("SOLOIST_PROXY_CONFIG") or DEFAULT_CONFIG_PATH
    p = Path(resolved)
    if not p.is_file():
        raise ConfigError(f"Config file not found: {p}")
    try:
        raw = yaml.safe_load(p.read_text())
    except yaml.YAMLError as e:
        raise ConfigError(f"Invalid YAML in {p}: {e}") from e

    data = _interpolate(raw or {}, env)
    if not isinstance(data, dict):
        raise ConfigError("Config root must be a mapping")
    _apply_env_overrides(data, env)

    soloist = data.get("soloist") or {}
    proxy = data.get("proxy") or {}
    snapcast = data.get("snapcast") or {}

    extra_args = soloist.get("extra_args") or []
    if not isinstance(extra_args, list):
        raise ConfigError("soloist.extra_args must be a list")

    return Config(
        soloist=SoloistConfig(
            device_name=_require(soloist.get("device_name"), "soloist.device_name (device name)"),
            api_key=_require(soloist.get("api_key"), "soloist.api_key (Spotify API Key)"),
            data_dir=soloist.get("data_dir") or DEFAULT_DATA_DIR,
            extra_args=[str(a) for a in extra_args],
            pipewire_device=(soloist.get("pipewire_device") or "").strip(),
        ),
        proxy=ProxyConfig(
            listen=proxy.get("listen") or DEFAULT_PROXY_LISTEN,
            token=_require(proxy.get("token"), "proxy.token (Auth Token)"),
        ),
        soloist_ws=data.get("soloist_ws") or DEFAULT_SOLOIST_WS,
        stream_name=snapcast.get("stream_name") or DEFAULT_STREAM_NAME,
    )


def _main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Load and validate the Soloist Proxy config.")
    ap.add_argument("--config", help="Path to the YAML config (default: $SOLOIST_PROXY_CONFIG or ./config.yaml)")
    args = ap.parse_args()
    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"config error: {e}", flush=True)
        return 1
    print(
        f"OK: device_name={cfg.soloist.device_name!r} api_key=<redacted> "
        f"data_dir={cfg.soloist.data_dir} "
        f"listen={cfg.proxy.listen} token=<redacted> "
        f"soloist_ws={cfg.soloist_ws} stream_name={cfg.stream_name} "
        f"extra_args={cfg.soloist.extra_args}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
