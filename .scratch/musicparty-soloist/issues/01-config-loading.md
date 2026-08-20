# 01: Config loading

**What to build:** A config loader that reads the YAML Config File, applies environment overrides with `${VAR}` interpolation (env wins over file), and exposes resolved, validated values to the rest of the app: Soloist settings (device name, API Key, extra args), the Proxy listen address and Auth Token, the internal Soloist WebSocket address, and the Docker-only Snapserver stream name. Missing required values fail fast with a clear message.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Loads YAML from `--config` / `$SOLOIST_PROXY_CONFIG`, defaulting to `./config.yaml`
- [ ] `${VAR}` references resolve from the environment; env values override file values
- [ ] Required fields (device name, API Key, Auth Token) missing → fail fast with a clear error
- [ ] Sensible defaults applied (proxy `0.0.0.0:8687`, soloist_ws `127.0.0.1:3678`, stream name `Spotify`)
- [ ] Self-test (assert-based) covers interpolation + env-wins precedence
