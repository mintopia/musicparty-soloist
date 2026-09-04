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

There is no `.env` and no environment configuration. Everything is set through the web
UI, which writes a single Config File (`./config/config.yaml`, bind-mounted into the
container). See [Configuration](#configuration) for the full model.

```bash
mkdir -p config              # bind-mounted at /config; the file is seeded on first boot
docker compose up -d         # pulls ghcr.io/mintopia/musicparty-soloist:latest
docker compose logs -f soloist
```

To upgrade later, pull the new image and recreate: `docker compose pull && docker compose up -d`.

Now open the web UI at **`http://<host>:8687`** and finish setup in the browser:

1. **Set up login.** On a fresh install the UI shows a **Setup Page** that only asks you
   to choose a web username and password. Everything else is locked until you do this.
2. **Log in** with those credentials. You land on the **Landing Page**.
3. **Fill in the config.** Set the Soloist **API Key** and **device name**, pick your
   **Audio Outputs**, toggle **autoplay**/webhooks as you like, and **Save**. Changing
   Soloist arguments (like the API key or device name) shows a *"restart soloist to
   apply"* banner with a button — click it once you're done so playback is never
   interrupted without your say-so.
4. **Pair with Spotify.** Once Soloist is running, open Spotify on any device on the same
   LAN and pick your device from the Connect menu (the speaker icon). Soloist logs in and
   writes the session into the `/data` volume, so it stays logged in across restarts.

After pairing:

- Web UI (Landing Page) at `http://<host>:8687`
- Lyrics Overlay at `http://<host>:8687/overlay` (unauthenticated — see below)
- Snapcast web UI at `http://<host>:1780`
- Snapclients connect to `<host>:1704`
- Control WebSocket at `ws://<host>:8687/?token=<Auth Token>`

### Host networking is required

This is the part that trips people up. The first Spotify login runs over Spotify
Connect, which is zeroconf/mDNS on the LAN. That traffic does not cross Docker's bridge
network, so the device never shows up in your Spotify app and you can never log in. So
`docker-compose.yml` uses `network_mode: host`, and that is why you need a Linux host.
Docker Desktop runs containers in a VM that isn't on your physical LAN, so it cannot
complete the login no matter how you wire it. The compose file keeps a commented
bridge/`ports:` block, but that is only good for poking at the proxy in isolation.

### No TLS here

The Proxy serves plain HTTP/WS and there is no built-in TLS, ACME, or certificate
handling — that was deliberately dropped. If you want HTTPS (e.g. to expose the web UI
or overlay beyond the LAN), put your own reverse proxy (Caddy, nginx, Traefik) in front
and terminate TLS there. Note the Snapcast web UI links to `<host>:1780` by hostname,
which assumes host networking; a front proxy that remaps ports will get that link wrong.

## Credentials

Five things get confused constantly, so they each get a row. All of them live in the
Config File now (in cleartext) and are set through the web UI — there are no environment
variables.

| Name | What it is | Where it lives |
|------|-----------|----------------|
| Web login | Username + password for the web UI itself. | `web.username` / `web.password`; set on the Setup Page. |
| API Key | Authorizes the Soloist app. It does **not** log a user in. | `soloist.api_key`; passed to Soloist as `--api-key`. |
| Spotify Login | The user session, obtained by pairing over Connect. | Not a config value — tap the device in Spotify; stored in `/data`. |
| Auth Token | Gates the Proxy WebSocket. Nothing to do with Spotify. | `proxy.token`; clients send `Bearer` or `?token=`. Autogenerated on first boot if empty. |
| Read-only Token | Observe-only WS access for the Lyrics Overlay. | `proxy.readonly_token`; autogenerated on first boot. Embedded into the overlay page for you. |

A valid API Key with no Spotify Login gives you `logged_in: false` and "Authentication
required" on control commands. That means pair the device. It does not mean the key is
wrong.

## The web UI

The Proxy serves the web UI on the same port as the control WebSocket (8687).

- **Setup Page** (`/setup`) — shown only on a fresh install with no web credentials. It
  sets the web username and password and nothing else; every other route fails closed
  until it's done.
- **Landing Page** (`/`) — the authenticated console. Edit every config value here
  (secrets are masked on read and preserved unless you type a new one), see live
  playback and webhook delivery status, manage Audio Outputs, and restart Soloist. Saves
  apply hot fields (tokens, webhooks, autoplay, overlay styling, Audio Output links)
  live; Soloist-argument changes are persisted but wait behind the restart banner.
- **Lyrics Overlay** (`/overlay`) — an unauthenticated page for OBS/browser sources. It
  uses the Read-only Token (embedded server-side, so the URL carries no secret) and
  observes playback only — it can never send control frames. Style it from the `overlay`
  config section (font, colours, effect, alignment, line count, anchor, timing offset).

## Configuration

Config is one YAML file — the single source of truth (ADR-0010). No environment
variables, no `${VAR}` interpolation: every value is used literally. Edit it by hand or
through the Landing Page, which writes it back **preserving your comments** and validates
before saving (it never persists a file that wouldn't boot). Autogenerated secrets
(`session_secret`, `proxy.token`, `readonly_token`) are minted and written back on first
boot if left empty.

In Docker the file is bind-mounted at `/config/config.yaml` (host `./config/config.yaml`)
and seeded from `config.example.yaml` on first boot. Standalone, the path is the
`--config` flag (default `./config.yaml`). See `config.example.yaml` for the fully
commented template; the sections are:

- `soloist` — `device_name`, `api_key`, `data_dir`, `extra_args`, `pipewire_device`.
- `proxy` — `listen`, `token` (Auth Token), `readonly_token`.
- `soloist_ws` — address of Soloist's own control WS.
- `web` — `username`, `password`, `session_secret`.
- `autoplay` — when on, the first time Soloist reports `logged_in: true` on each upstream
  connection the Hub injects `activate` then `play`, so the device becomes the active
  Connect player and starts playing without a client command. Off by default.
- `webhooks` — outbound POST of raw event JSON per Soloist event. `default_url` catches
  the ten state events (`auth_state`, `playback_state`, `track_changed`,
  `playback_changed`, `volume_changed`, `device_changed`, `context_changed`,
  `options_changed`, `position_sync`, `queue_changed`); entries under `urls` replace the
  default for that `type`, so each event hits exactly one URL. `command_result`/`error`
  fire only with an explicit `urls` entry. `secret`, if set, is sent as
  `Authorization: Bearer <secret>`. `delay_ms` enforces a global minimum interval via a
  bounded (1000) drop-oldest FIFO queue. Best-effort: fire-and-forget, ~5s timeout,
  non-2xx/timeout logged, never retried, never blocks relay. Omit to disable.
- `snapcast.stream_name` — Snapcast stream name (Docker audio path only).
- `audio` — Audio Outputs (see below).
- `overlay` — Lyrics Overlay styling embedded into the overlay page.

A few structural fields are shown **read-only** in the UI (they can lock you out or break
the container if changed live) and remain hand-edit-only: `proxy.listen`,
`soloist.extra_args`, and `soloist.data_dir`.

Two paths are still read from the environment (infrastructure, not app config, so they
survived the env removal): `SOLOIST_CACHE_DIR` (where the downloaded Soloist binary is
cached; `/cache` in the image) and `SOLOIST_DOWNLOAD_BASE` (base URL the binary is
fetched from).

### Audio Outputs (Docker only)

Soloist plays into a PipeWire null-sink, and the Proxy fans that audio out to the outputs
you enable — it owns every `pw-link` (ADR-0011). Two kinds of output:

- **Snapcast** (`audio.snapcast`, on by default) — a synthetic toggle in the UI. When on,
  the captured stream is served to LAN Snapclients (ports 1704/1705, web UI on 1780).
- **Hardware sinks** (`audio.outputs`) — a list of PipeWire `node.name`s. The UI lists the
  real sinks it can see so you can tick them. A configured output whose node never appears
  is skipped and flagged, not fatal.

**Hardware output needs device passthrough.** Out of the box the container sees no host
audio devices, so Snapcast is the only output available. To play to real speakers you
must map the host's audio devices into the container — for ALSA, add the device and
(optionally) the group to `docker-compose.yml`:

```yaml
    devices:
      - /dev/snd:/dev/snd     # expose ALSA devices to the container
    group_add:
      - audio                 # so the container user may open them
```

Then recreate the container; the new sinks appear in the Audio Outputs list to enable.

## Ports

| Port | Service |
|------|---------|
| 8687 | Auth proxy (control WebSocket) + web UI + Lyrics Overlay |
| 1704 | Snapcast audio stream |
| 1705 | Snapcast control (TCP JSON-RPC) |
| 1780 | Snapcast web UI |

## Standalone (npx, no Snapcast)

Runs everything except the Snapcast fan-out: Soloist itself (supervised, auto-reacquired),
the web UI with synced lyrics, the webhooks, the authenticated control WebSocket, and the
WebSocket relay. There is no Snapserver and no multi-output PipeWire routing — Soloist plays
straight to a PipeWire device on the host. Point it at a specific device if you don't want
Soloist's default.

Once published you can run it with no checkout:

```bash
npx @mintopia/musicparty-soloist --config config.yaml
```

Or build from source:

```bash
npm install
npm run build
cp config.example.yaml config.yaml   # then set data_dir to ./.soloist-data
node dist/main.js --config config.yaml
```

Flags:

- `--config <path>` — Config File location (default `./config.yaml`).
- `--pipewire-device <name>` — optional; the PipeWire node Soloist outputs to. Equivalent to
  setting `soloist.pipewire_device` in the Config File or the **PipeWire output device** field
  on the Settings page (a change there needs a Soloist restart, which the UI prompts for).
  Leave it unset to use Soloist's default sink. `--docker` is reserved for the container image
  and turns on the Snapcast fan-out — do not pass it in standalone.

On first run, with no web credentials in the file, the Proxy serves the Setup Page at
`http://localhost:8687/setup` to set them; then log in and edit the rest in the browser.
`SIGINT` and `SIGTERM` shut it down cleanly — Soloist is terminated first, then the process
exits.

Audio out needs PipeWire running on the host (Linux). And the one-time Spotify login still
needs LAN zeroconf, so run it on a host that sits on the LAN, not inside an isolated container.

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
