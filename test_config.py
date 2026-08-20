"""Assert-based self-test for the config loader.

Runnable standalone (`python3 test_config.py`) or under pytest. No fixtures.
"""

import tempfile
from pathlib import Path

from soloist_proxy.config import (
    DEFAULT_PROXY_LISTEN,
    DEFAULT_SOLOIST_WS,
    DEFAULT_STREAM_NAME,
    ConfigError,
    load_config,
)

BASE = """
soloist:
  device_name: "Party Speaker"
  api_key: "${SOLOIST_API_KEY}"
  extra_args: ["--verbose", "${EXTRA_ARG}"]
proxy:
  listen: "${PROXY_LISTEN:-0.0.0.0:8687}"
  token: "${PROXY_TOKEN}"
soloist_ws: "127.0.0.1:3678"
snapcast:
  stream_name: "${SNAPCAST_STREAM:-Spotify}"
"""

FULL_ENV = {"SOLOIST_API_KEY": "spak_x", "PROXY_TOKEN": "tok", "EXTRA_ARG": "--debug"}


def _write(tmp, text=BASE):
    p = Path(tmp) / "config.yaml"
    p.write_text(text)
    return str(p)


def test_interpolation():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = load_config(_write(tmp), env=FULL_ENV)
        assert cfg.soloist.api_key == "spak_x"
        assert cfg.proxy.token == "tok"
        assert cfg.soloist.extra_args == ["--verbose", "--debug"]


def test_env_wins_over_file_default():
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp)
        # env unset -> file-provided defaults apply
        cfg = load_config(path, env=FULL_ENV)
        assert cfg.stream_name == "Spotify"
        assert cfg.proxy.listen == "0.0.0.0:8687"
        # env set -> env wins over the file default
        cfg2 = load_config(path, env={**FULL_ENV, "SNAPCAST_STREAM": "Jazz", "PROXY_LISTEN": "1.2.3.4:9"})
        assert cfg2.stream_name == "Jazz"
        assert cfg2.proxy.listen == "1.2.3.4:9"


def test_missing_required_fails_fast():
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp)
        try:
            load_config(path, env={"PROXY_TOKEN": "tok"})  # SOLOIST_API_KEY unset -> empty
        except ConfigError as e:
            assert "api_key" in str(e).lower()
        else:
            raise AssertionError("expected ConfigError for missing api_key")


def test_defaults_when_sections_absent():
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp, "soloist:\n  device_name: d\n  api_key: k\nproxy:\n  token: t\n")
        cfg = load_config(path, env={})
        assert cfg.proxy.listen == DEFAULT_PROXY_LISTEN
        assert cfg.soloist_ws == DEFAULT_SOLOIST_WS
        assert cfg.stream_name == DEFAULT_STREAM_NAME
        assert cfg.soloist.extra_args == []


def test_config_path_from_env():
    with tempfile.TemporaryDirectory() as tmp:
        path = _write(tmp)
        cfg = load_config(None, env={**FULL_ENV, "SOLOIST_PROXY_CONFIG": path})
        assert cfg.soloist.device_name == "Party Speaker"


def test_missing_file_fails():
    try:
        load_config("/no/such/config.yaml", env={})
    except ConfigError as e:
        assert "not found" in str(e).lower()
    else:
        raise AssertionError("expected ConfigError for missing file")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} checks passed")
