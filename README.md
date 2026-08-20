# Musicparty Soloist

A wrapper around [Spotify Soloist](https://developer.spotify.com/documentation/soloist),
the headless Linux Spotify Connect client. It adds authenticated remote access to
Soloist's control WebSocket, and in its Docker form it pipes Soloist's audio into a
[Snapcast](https://github.com/badaix/snapcast) server for multi-room playback.

Two jobs:

1. **Supervisor.** Downloads the Soloist binary at runtime, launches it with your
   settings, and keeps it running. When a build expires it re-downloads and restarts.
2. **Proxy.** A WebSocket server in front of Soloist's own control WS, which is
   unauthenticated and bound to localhost. The proxy gates every connection on a shared
   token, then relays frames unchanged. Many clients share one upstream connection.

The Docker image also routes Soloist's audio through a PipeWire null-sink into a
pipewire-enabled Snapserver, so LAN Snapclients can play it.

## Requirements

- A Spotify Premium account and a Soloist API Key from the Spotify for Developers
  dashboard.
- Docker on a Linux host for the full audio deployment. This will not work under Docker
  Desktop on macOS or Windows. The networking note below explains why.
- Node.js 22+ if you only want the standalone proxy.

The Soloist binary is downloaded at runtime and never committed or baked into the image,
because redistributing it is prohibited. Builds expire about 90 days after they are cut.
The supervisor watches for that and re-downloads on its own.

## Quick start (Docker, Linux)

```bash
cp .env.example .env          # then edit: set SOLOIST_API_KEY and PROXY_TOKEN
docker compose up -d --build
docker compose logs -f soloist
```

On first run the log stops at:

```
waiting for login — connect to "Music Party" from your Spotify app
```

Now do the one-time login. Open Spotify on any device on the same LAN and pick your
device from the Connect menu (the speaker icon). Soloist logs in and writes the session
into the `/data` volume, so it stays logged in across restarts.

After login:

- Snapcast web UI at `http://<host>:1780`
- Snapclients connect to `<host>:1704`
- Control WebSocket at `ws://<host>:8687/?token=<PROXY_TOKEN>`

### Host networking is required

This is the part that trips people up. The first Spotify login runs over Spotify
Connect, which is zeroconf/mDNS on the LAN. That traffic does not cross Docker's bridge
network, so the device never shows up in your Spotify app and you can never log in. So
`docker-compose.yml` uses `network_mode: host`, and that is why you need a Linux host.
Docker Desktop runs containers in a VM that isn't on your physical LAN, so it cannot
complete the login no matter how you wire it. The compose file keeps a commented
bridge/`ports:` block, but that is only good for poking at the proxy in isolation.

## Secrets

These get confused constantly, so they each get a row.

| Name | What it is | How you supply it |
|------|-----------|-------------------|
| API Key | Authorizes the Soloist app. It does not log a user in. | `SOLOIST_API_KEY`, passed as `--api-key` |
| Spotify Login | The user session, obtained by pairing over Connect. | Tap the device in Spotify. Stored in `/data`. |
| Auth Token | Gates our proxy. Nothing to do with Spotify. | `PROXY_TOKEN`. Clients send `Bearer` or `?token=`. |

A valid API Key with no Spotify Login gives you `logged_in: false` and "Authentication
required" on control commands. That means pair the device. It does not mean the key is
wrong.

## Configuration

Config is a YAML file. Copy `config.example.yaml` to `config.yaml`. Any value can be
overridden from the environment with `${VAR}` or `${VAR:-default}` interpolation, and the
environment wins over the file default.

```yaml
soloist:
  device_name: "${SOLOIST_DEVICE_NAME:-Music Party}"
  api_key: "${SOLOIST_API_KEY}"
  data_dir: "${SOLOIST_DATA_DIR:-./.soloist-data}"
  extra_args: []
  pipewire_device: "${SOLOIST_PIPEWIRE_DEVICE:-}"   # Docker audio route; empty standalone
proxy:
  listen: "${PROXY_LISTEN:-0.0.0.0:8687}"
  token: "${PROXY_TOKEN}"
soloist_ws: "127.0.0.1:3678"
autoplay: "${AUTOPLAY:-false}"                       # start playing on login
webhooks:
  default_url: "${WEBHOOK_URL:-}"                    # catch-all for state events
  urls: {}                                           # per-type overrides
  secret: "${WEBHOOK_SECRET:-}"                      # Authorization: Bearer <secret>
  delay_ms: "${WEBHOOK_DELAY_MS:-0}"                 # min ms between POSTs
snapcast:
  stream_name: "${SNAPCAST_STREAM:-Spotify}"        # Docker only
```

With `autoplay` on, the first time Soloist reports `logged_in: true` on each upstream
connection the Hub injects `activate` then `play`, so the device becomes the active
Spotify Connect player and starts playing without a client command. Off by default.

With `webhooks` set, the Hub POSTs the raw event JSON (`Content-Type: application/json`)
to a URL per event. `default_url` catches the ten state events (`auth_state`,
`playback_state`, `track_changed`, `playback_changed`, `volume_changed`, `device_changed`,
`context_changed`, `options_changed`, `position_sync`, `queue_changed`); entries under
`urls` replace the default for that `type`, so each event hits exactly one URL.
`command_result`/`error` fire only when given an explicit `urls` entry. `secret`, if set,
is sent as `Authorization: Bearer <secret>` on every POST. `delay_ms` enforces a global
minimum interval between POSTs via a bounded (1000) drop-oldest FIFO queue. Delivery is
best-effort: fire-and-forget, ~5s timeout, non-2xx/timeout logged, never retried, and a
webhook never blocks relay. Omit the section to disable. Off by default.

The example config wires these env vars.

| Variable | What it does | Default | Example |
|----------|--------------|---------|---------|
| `SOLOIST_API_KEY` | Soloist API Key that authorizes the app. Not a login. | required | `AbCdEf123...` |
| `PROXY_TOKEN` | Auth token clients present to reach the proxy. | required | `long-random-string` |
| `SOLOIST_DEVICE_NAME` | Connect device name shown in the Spotify app. | `Music Party` | `Music Party Docker` |
| `AUTOPLAY` | Make the device active and start playing once it logs in. | `false` | `true` |
| `WEBHOOK_URL` | Catch-all URL POSTed for the ten state events. Empty means off. | empty | `http://10.0.0.5:8002/s/music` |
| `WEBHOOK_SECRET` | Sent as `Authorization: Bearer <secret>` on every POST. | empty | `s3cret` |
| `WEBHOOK_DELAY_MS` | Global minimum interval between POSTs. 0 is off. | `0` | `250` |
| `SNAPCAST_STREAM` | Snapcast stream name. Docker audio path only. | `Spotify` | `Spotify` |
| `PROXY_LISTEN` | Address the proxy binds. | `0.0.0.0:8687` | `127.0.0.1:8687` |
| `SOLOIST_DATA_DIR` | Session data dir that holds the login after pairing. | `./.soloist-data` | `/data` |
| `SOLOIST_PIPEWIRE_DEVICE` | Null-sink Soloist plays into. Empty means no audio (standalone). | empty | `soloist-sink` |

Two more are read directly, outside the config file, by the binary cache and download.

| Variable | What it does | Default |
|----------|--------------|---------|
| `SOLOIST_CACHE_DIR` | Where the downloaded Soloist binary is cached. | `./.soloist-cache` |
| `SOLOIST_DOWNLOAD_BASE` | Base URL the binary is fetched from. | `https://soloist-builds.spotifycdn.com` |

Values in `.env` are read literally (compose `env_file` with `format: raw`), so paste
keys exactly as they are, `$` and all, with no escaping.

## Ports

| Port | Service |
|------|---------|
| 8687 | Auth proxy (control WebSocket) |
| 1704 | Snapcast audio stream |
| 1705 | Snapcast control (TCP JSON-RPC) |
| 1780 | Snapcast web UI |

## Standalone proxy (no audio, any OS)

Runs the supervisor and proxy without the Snapcast audio path.

```bash
npm install
npm run build
node dist/main.js --config config.yaml
```

The only flag is `--config`. `SIGINT` and `SIGTERM` shut it down cleanly. Soloist is
terminated first, then the process exits.

One catch: the standalone still needs the one-time Spotify login, which still needs LAN
zeroconf. Run it on a host that sits on the LAN, not inside an isolated container.

## Development

```bash
npm run build      # tsc -> dist/
npm test           # build, then the assert-based self-check (auth gate, arch map, config, webhook routing/throttle)
npm start          # node dist/main.js
```

TypeScript on Node 22. The only runtime dependencies are `ws` and `yaml`. Tar extraction
shells out to the system `tar`. The constant-time token compare and the HTTPS download
are Node built-ins.

## How the pieces fit

```
Downstream clients ──ws (token)──> Proxy(8687) ──ws──> Soloist WS(127.0.0.1:3678)
                                     │ Hub: broadcast + observe/inject frames
                                     ├─ autoplay ─> injects activate/play on login
                                     └─ webhooks ─> POST each event to configured URLs
Supervisor ── spawns/restarts ──> soloist ── audio ──> PipeWire null-sink
                                                          │
                                              Snapserver (pipewire capture)
                                                          │
                                          Snapclients(1704) + web UI(1780)
```

Inside the Proxy, the Hub holds the single upstream connection: it broadcasts every
Soloist frame to all clients, and (when enabled) decodes each frame once to drive
autoplay and webhooks. It never rewrites relayed client traffic. See ADR-0006.

See `CONTEXT.md` for the domain glossary and `docs/adr/` for the recorded decisions.

## License

[MIT](LICENSE) © 2026 Jessica Smith
