# 01: Config loading

**What to build:** A config loader that reads the YAML Config File, applies environment overrides with `${VAR}` interpolation (env wins over file), and exposes resolved, validated values to the rest of the app: Soloist settings (device name, API Key, extra args), the Proxy listen address and Auth Token, the internal Soloist WebSocket address, and the Docker-only Snapserver stream name. Missing required values fail fast with a clear message.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Loads YAML from `--config` / `$SOLOIST_PROXY_CONFIG`, defaulting to `./config.yaml`
- [x] `${VAR}` references resolve from the environment; env values override file values
- [x] Required fields (device name, API Key, Auth Token) missing → fail fast with a clear error
- [x] Sensible defaults applied (proxy `0.0.0.0:8687`, soloist_ws `127.0.0.1:3678`, stream name `Spotify`)
- [x] Self-test (assert-based) covers interpolation + env-wins precedence

## Comments

Implemented in `soloist_proxy/config.py` (loader) with `test_config.py` (7 assert-based checks). Env-override works two ways: `${VAR}`/`${VAR:-default}` interpolation and a direct per-key env layer (e.g. `SOLOIST_API_KEY`, `PROXY_TOKEN`) so plain file literals are overridable too — matching the CONTEXT.md "every value is env-overridable" contract. Merged to `main` in `dcd048a`.
