# Plan — Musicparty Soloist

Wrapper around Spotify Soloist: authenticated remote access to its control WebSocket,
plus a Docker image that pipes its audio into Snapcast. See `CONTEXT.md` for the
glossary and `docs/adr/` for the two recorded decisions.

## Deliverable 1 — Standalone Python script (no audio)

Single `asyncio` app (Python 3, `websockets` lib). Responsibilities:

1. **Config load** — YAML from `--config` / `$SOLOIST_PROXY_CONFIG` (default `./config.yaml`).
   Env-overridable; `${VAR}` interpolation; env wins.
   ```yaml
   soloist:    { device_name: "Party Speaker", api_key: "${SOLOIST_API_KEY}", extra_args: [] }
   proxy:      { listen: "0.0.0.0:8687", token: "${PROXY_TOKEN}" }
   soloist_ws: "127.0.0.1:3678"
   snapcast:   { stream_name: "Spotify" }   # Docker-only; script ignores it
   ```
2. **Soloist binary** — auto-detect arch (`platform.machine()` → `x86_64` / `arm64` /
   `arm32`), download tarball to a cached dir if missing or >60 days old, `tar -xzf`,
   validate with `soloist --version` (exit 0). Download is mandatory — redistribution
   of the binary is prohibited, so it is never baked in.
3. **Supervise Soloist** — launch with `-w 127.0.0.1:3678`, `--device-name`,
   `--api-key`, `--data-dir <persistent>`, plus `extra_args`. Watch the process:
   - **exit 10** (expired) → re-download + restart.
   - other non-zero → log + restart with backoff.
4. **Proxy** — WS server on `proxy.listen`. On upgrade: read token from `Authorization:
   Bearer` header or `?token=`, constant-time compare against `proxy.token`, 401 if
   bad/missing. On success: dial `soloist_ws`, relay frames both ways. Multi-client
   fan-out (N clients ↔ 1 Soloist WS). Logs to stdout.

**One runnable check**: assert-based self-test for the auth gate (good token passes,
bad/missing token → 401) and the arch-map. No framework.

## Deliverable 2 — Docker image (adds audio, host networking)

Runs Deliverable 1 inside, plus the audio path. **s6-overlay** is PID 1.

Services (ordered):
1. **PipeWire** — start daemon; create null-sink `soloist-sink`.
2. **Snapserver** — pipewire-enabled build (`*_with-pipewire`; verify
   `ldd $(which snapserver) | grep pipewire`). `snapserver.conf` rendered from the
   config's `snapcast.stream_name`:
   `source = pipewire://?name=<stream_name>&capture_sink=true&target=soloist-sink`,
   `sampleformat=48000:16:2`, FLAC.
3. **App** — the Python script, with Soloist launched `--pipewire-device soloist-sink`.

- **Networking**: host mode (Snapserver reaches LAN clients on 1704/1705; Proxy on 8687).
- **Volumes**: persistent `--data-dir` (Soloist session cache) + cached binary dir.
- **Healthcheck**: TCP probe on 8687.
- **Bootstrap**: creds come from `--api-key` (env/config). No interactive pairing step.

## Build order

1. Config loader + arch/download/validate + self-test.
2. Soloist supervisor (exit-10 recovery).
3. Proxy (auth gate + fan-out relay) + self-test.
4. Dockerfile: base + PipeWire + pipewire-enabled Snapserver + s6 services.
5. `snapserver.conf` template rendering from config.
6. End-to-end: container up → Spotify Connect device appears → audio in Snapcast → authed WS control.

## Open implementation risks

- Soloist WS message schema is documented but treated as representative — verify against
  a live daemon before relying on specific event fields.
- Confirm the chosen base image's Snapserver package actually carries the pipewire source
  (ADR-0002 fallback if not).
