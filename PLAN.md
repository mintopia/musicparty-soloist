# Plan: Web UI config, Landing Page, playback control, Audio Outputs, and Lyrics Overlay

_Locked via grill-with-docs — by Claude + Jess. Terms per CONTEXT.md. Codex Act 2 skipped by request._

## Goal

Make the Config File the single source of truth for all settings, editable both by hand and
through the Proxy's Landing Page — **no environment configuration**. Extend the Proxy so its
existing port serves an authenticated Landing Page, a first-run Setup Page, and an
unauthenticated Lyrics Overlay. Behind a Web Session the Landing Page edits the whole config
(with sharp fields shown read-only), shows Soloist WebSocket details, links to Snapweb, lists
Webhooks with their Webhook Status, gives playback status and controls (over the existing WS),
selects Audio Outputs, and edits the Overlay Config. The Lyrics Overlay renders time-synced
lyrics for the current track, reading playback via a Read-only Token and its styling embedded
server-side from the Overlay Config. No TLS/ACME/Caddy — the operator fronts it with a reverse
proxy.

## Approach

1. **Config model change — remove env, make the file authoritative** (`src/config.ts`):
   - Delete `${VAR}` interpolation and all `process.env` config reads; the `--config` flag is
     the only path input (default `./config.yaml`; `/config/config.yaml` bind-mount in Docker).
   - Add config: `web.username`, `web.password`, `web.session_secret`, `proxy.readonly_token`,
     `audio.outputs` (list of PipeWire `node.name` + a Snapcast toggle), Overlay Config section.
   - Split load vs. save: a `saveConfig(path, config)` that validates (same required/type
     checks as load), round-trips via the `yaml` Document API to preserve comments, and writes
     atomically (temp + rename in the same dir). Never persist a config that fails validation.
   - On boot: if `web.session_secret` / `proxy.readonly_token` are absent, autogenerate and
     persist them back into the file. [ADR-0010]

2. **First-run Setup Page** (`src/web.ts` + `src/web/setup.html`):
   - When `web.username`/`web.password` are unset, the Proxy serves ONLY the Setup Page
     (unauthenticated) that sets those two values, writes the file, and redirects to `/login`.
     Everything else fails closed; Soloist is not spawned in this state. [ADR-0010]

3. **Boot into setup mode** (`src/main.ts`):
   - The Proxy HTTP/WS server always starts. Soloist supervision starts only once the config
     is minimally valid (web creds + Soloist args present). Setup mode = HTTP up, no Soloist.

4. **Read-only token tier + state cache in the Hub** (`src/proxy.ts`):
   - `checkAuth` classifies a connection `control | readonly | none` (control = Auth Token or
     valid Web Session cookie; readonly = Read-only Token). Timing-safe compares.
   - `hub.register(client, { readOnly })`; read-only client→upstream frames are dropped.
   - Hub keeps a `latestState` cache (most recent decoded frame per state `type`) and replays
     it to newly connected clients / the Landing Page so they render immediately.

5. **HTTP router on the existing server** (`src/web.ts`):
   - Routes: `GET /setup` + `POST /setup` (first-run only), `GET /` (Landing Page,
     cookie-gated → else 302 `/login`), `GET /login` + `POST /login` + `POST /logout`,
     `GET /overlay` (open; overlay config + Read-only Token embedded server-side),
     `GET/PUT /api/config` (authenticated; full config read/write, secrets masked on read),
     `GET /api/webhooks`, `GET /api/config-summary`, `GET /api/pipewire-sinks`,
     `POST /api/restart-soloist`, and static assets. The `upgrade` handler stays for the WS.
   - Static assets from `src/web/` copied to `dist/web/` (build copy step; `tsc` skips non-TS).
   - Cookie signing/verifying with `node:crypto` HMAC (no new dependency). Timing-safe.

6. **Apply model on save** (`src/main.ts` / `src/proxy.ts`):
   - Hot (Auth Token, Read-only Token, webhooks, autoplay, Overlay Config) → apply live.
   - Audio Output changes → reconcile `pw-link`s live (item 8).
   - Soloist-arg changes (device name, API Key, `soloist_ws`) → persisted, NOT auto-applied;
     the Landing Page shows a "changes pending — restart soloist to apply (interrupts
     playback)" banner + a **Restart soloist** button (`POST /api/restart-soloist`, aborts and
     re-enters one `supervise` iteration). Button doubles as reconnect/re-pair. [ADR-0010]

7. **Proxy owns PipeWire fan-out** (`src/audio.ts` + `docker/s6-rc.d/snapserver/run`):
   - Remove the s6 `pw-link` loop; hardcode s6 `wait-for-sink` to `soloist-sink`; drop the
     `SOLOIST_PIPEWIRE_DEVICE` env. [ADR-0011]
   - `reconcileOutputs(config)`: enumerate current `soloist-sink:monitor` links, `pw-link`
     enabled outputs (Snapcast → Snapserver capture node, special-cased; hardware sinks →
     `<sink>:playback_{FL,FR}`), `pw-link -d` deselected; wait/retry for a target to appear;
     shell out with `XDG_RUNTIME_DIR=/run/pipewire`. Run on boot and on output-config save.
   - `GET /api/pipewire-sinks` shells `pw-dump`, returns `{name, description}` minus
     `soloist-sink`; Snapcast always shown as a synthetic toggle. [ADR-0011]

8. **Webhook Status** (`src/proxy.ts`): `attachWebhooks` records per-destination stats
   (lastStatus, lastAt, ok, fail, lastError); `GET /api/webhooks` returns the configured list
   (types → URLs, secret presence boolean) plus the live stats map.

9. **Config summary** (`src/proxy.ts`): `GET /api/config-summary` returns device name,
   `soloist_ws`, autoplay, stream name, the WS URL, and booleans for whether each secret is
   set. Never returns a secret value. (`GET /api/config` is the authenticated editor read;
   masks secret values too — the UI shows "set/unset" and lets you replace, not read back.)

10. **Landing Page UI** (`src/web/landing.html` + assets):
    - Sections: config editor (whole Config File; `proxy.listen`, `soloist.extra_args`,
      `soloist.data_dir` rendered read-only), WebSocket + config details, Snapweb link
      (`http://<location.hostname>:1780`), Webhooks + Webhook Status, playback status +
      controls (opens the WS with the cookie), Audio Outputs (multi-select with live sink
      list), the Overlay Config editor (builder + live preview), and the pending-restart
      banner. **Save** does `PUT /api/config`.
    - Login + Setup are separate small styled forms.
    - **Build to the design:** all web surfaces follow `DESIGN.md` (Clean & Light, teal) and the
      hi-fi mockups in `docs/design/mockups/` (landing → T10, setup/login → T2/T3, overlay →
      T5). Lift the token block verbatim; verify each surface against its mockup, then run the
      impeccable detector.

11. **Lyrics Overlay** (`src/web/overlay.html`):
    - Import the prototype engine verbatim (`parseLRC`, `currentIndex`, `makeRenderer`,
      effects CSS, lrclib fetch + localStorage cache, entity helpers). Two edits: it connects
      with the server-embedded Read-only Token, and reads styling from the server-embedded
      Overlay Config subset (inline `<script>`) — no `/api/overlay-config` fetch. Picks up
      config changes on reload (live push out of scope).

12. **Tests** (`src/selftest.ts`): fold in `test-lyrics.mjs` (parseLRC / currentIndex). Add
    asserts: read-only connections drop upstream frames; cookie sign/verify round-trip +
    tamper rejection; web auth fails closed when creds unset (→ setup mode); `config-summary`
    and `GET /api/config` never leak a secret value; `saveConfig` round-trips + preserves
    comments + rejects invalid config + writes atomically.

13. **Docker + docs**: `docker-compose.yml` bind-mounts `/config/config.yaml`, drops all
    config env; delete `.env.example`; README section for the web UI (setup, ports,
    credentials, config editing, Audio Outputs incl. device passthrough, overlay URL, the
    no-TLS-here note); release notes flag env removal as breaking. CONTEXT.md and ADRs
    0007–0011 already written.

## Key decisions & tradeoffs

- Config File is the single source of truth, UI-editable, **no env** — one mental model,
  breaking change from the env-overridable model. [ADR-0010]
- Secrets live in the file in cleartext; autogenerated tokens persisted on first boot. [ADR-0010]
- First-run Setup Page (creds-only, unauthenticated) solves bootstrap without env. [ADR-0010]
- Sharp fields (`proxy.listen`, `extra_args`, `data_dir`) shown read-only to prevent lockout.
- Saves never interrupt playback silently; Soloist-arg changes gated behind a button. [ADR-0010]
- Audio Outputs are config-driven; the Proxy owns all `pw-link`s; Snapcast is a toggleable
  output (default on). Docker-only; hardware output needs operator device passthrough. [ADR-0011]
- Overlay Config is a section of the Config File; the Proxy embeds only that subset + the
  Read-only Token into the overlay HTML — the unauthenticated overlay never reads the file.
- HTTP surface lives in the Proxy process on the same port as the WS. [ADR-0007]
- Read-only Token tier for the overlay. [ADR-0008]. Session-cookie login. [ADR-0009]
- Webhook Status is in-memory observed delivery stats, reset on restart.
- **TLS/ACME/Caddy dropped** — operator's reverse-proxy responsibility.

## Risks / open questions

- **Config file must be writable** by the container for UI saves; a read-only mount makes the
  UI read-only — surface a clear error on save failure.
- **Hardware Audio Outputs are host-dependent**: only present if the operator maps audio
  devices in; out of the box Snapcast is the only output. Documented.
- **Snapweb link uses `location.hostname:1780`** — correct under host networking; wrong if a
  front proxy remaps ports. Acceptable given no-TLS-here scope.
- **lrclib fetched client-side from the overlay** — needs outbound internet + CORS from lrclib.
- Static-file serving needs a build copy step; guard against path traversal (fixed allowlist).

## Out of scope

- TLS, ACME, Caddy, any reverse proxy.
- Editing `proxy.listen` / `extra_args` / `data_dir` from the UI (read-only display).
- Named overlay presets / multiple overlays; live config push to a running overlay.
- Persisted webhook delivery history.
- Server-side lyric fetching or a shared lyric cache.
- Container self-restart from the UI (operator uses `docker restart` for YAML-only fields).
