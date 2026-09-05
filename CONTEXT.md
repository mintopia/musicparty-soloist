# Musicparty Soloist

A wrapper around Spotify Soloist (a headless Linux Spotify Connect client) that
adds authenticated remote access to its control WebSocket, and — in its Docker
form — pipes its audio into a Snapcast server.

## Language

**Soloist**:
The upstream Spotify headless Spotify Connect client daemon (`soloist`). Downloaded
at runtime; builds expire 90 days after their build date (exit code 10).
_Avoid_: client, player.

**Soloist WebSocket**:
Soloist's own local control WebSocket, enabled with `-w/--ws ADDR:PORT`.
Unauthenticated by design; bound to localhost only.
_Avoid_: upstream socket, control socket.

**Proxy**:
Our TypeScript/Node WebSocket server that sits in front of the Soloist WebSocket. Its only
job is authentication: it gates connections on a shared token, then transparently
relays frames both ways. No message rewriting.
_Avoid_: gateway, bridge (bridge means the audio path — see Snapcast).

**Hub** (`SoloistHub`):
The single upstream connection inside the Proxy that reconnects to the Soloist WebSocket
with backoff and broadcasts each frame to every Downstream Client. It decodes each frame's
`type` once and dispatches to registered observers (Autoplay, Webhook), and can *originate*
frames upstream (Autoplay's `activate`/`play`). Relayed client traffic is still never
rewritten — the Hub only reads and, for injected frames, writes traffic that is not a
client's (ADR-0006 amending ADR-0001).
_Avoid_: Proxy (that is the auth front; the Hub is the frame core behind it).

**Auth Token**:
A single shared secret. A Downstream Client presents it as `Authorization: Bearer
<token>` or `?token=<token>`; a bad/missing token is rejected 401 at the WS upgrade.
_Avoid_: API key (that is the Spotify API Key — a different thing), password.

**API Key**:
The Spotify-for-Developers private key passed to Soloist as `--api-key`. It authorizes
the *app*, not a user — it does not log anyone in. Supplied via env/config, never committed.
_Avoid_: Auth Token (that gates our Proxy), Spotify credentials, secret.

**Spotify Login** (Connect pairing):
Separate from the API Key. Soloist starts `logged_in: false` and waits for a Spotify
user to claim the device over Spotify Connect (zeroconf/mDNS on the LAN) — tap the device
in your Spotify app, or run `soloist --pair` once. The session is then stored in the
`--data-dir` (`/data` volume) and reused on restart. Because the handshake is zeroconf,
first-time login only works with **host networking** on the LAN, not bridge networking.
_Avoid_: API Key (authorizes the app, not the user), Auth Token (gates our Proxy).

**Downstream Client**:
A remote consumer that connects to the Proxy to observe playback and send commands.
_Avoid_: user, subscriber.

**Audio Route** (Docker only):
Soloist plays into a PipeWire null-sink (`soloist-sink`); its monitor is fanned out to one
or more Audio Outputs. Snapserver is one such output, capturing via its native
`pipewire://` source (`capture_sink=true`, `48000:16:2`, FLAC); local hardware sinks are
others. Requires a pipewire-enabled Snapserver build. A headless WirePlumber (see ADR-0003)
gives the sink its ports; it does *not* auto-link Snapserver's capture node (WirePlumber 0.5
treats it as a device, not a capture client), so the Proxy owns the links — it `pw-link`s
`soloist-sink:monitor` to each enabled output and unlinks disabled ones (ADR-0011). No FIFO,
no external capture process. The null-sink is the stable anchor.
_Avoid_: FIFO, pipe, bridge.

**Audio Output** (Docker only):
A PipeWire sink that Soloist's audio is routed to. The operator selects any number in the
Landing Page: Snapcast is one (toggleable, on by default); local hardware sinks are others,
present only if the operator maps audio devices into the container. Stored in the Config
File by PipeWire `node.name`; the Proxy reconciles the `pw-link`s on save and on boot.
_Avoid_: sink (generic), device, Audio Route (that is the whole path — an Output is one leg).

**Snapserver**:
The Snapcast server, run inside the Docker image on host networking so LAN clients
reach it. Its stream name is operator-configurable.
_Avoid_: snapcast (that is the project/protocol; the process is snapserver).

**Autoplay**:
Opt-in Hub behavior (off by default). Once the upstream connection is up and Soloist
reports `logged_in: true` (via an `auth_state` event), the Hub injects `activate` then
`play` so this device becomes the active Spotify Connect player and starts playing.
Fires once per upstream connection, on the first logged-in state seen; a Soloist restart
(already paired) re-asserts on reconnect. No re-fire on later `auth_state` frames.
_Avoid_: play (that is one Soloist command, not the behavior), resume, take-over.

**Webhook**:
An outbound HTTP POST the Hub sends when a Soloist event arrives downstream, carrying
the raw event JSON verbatim. The operator maps event `type`s to URLs: a `default_url`
catch-all for the ten state events, and per-`type` overrides that *replace* the default
for that type. Optional single shared `secret` is sent as `Authorization: Bearer`.
Best-effort: fire-and-forget with a short timeout, a global min-interval throttle
(`delay_ms`) over a bounded drop-oldest FIFO queue. No retries.
_Avoid_: callback; event (the *event* is the Soloist message — the Webhook is our POST of it).

**Relay**:
A persistent *outbound* WebSocket the Hub opens to a single operator-configured Relay
Server, forming a bidirectional bridge. Every genuine Soloist→downstream frame is
republished to the Relay Server verbatim (the same frames a Downstream Client observes,
unfiltered — unlike the Webhook's ten-event subset); every frame received back from the
Relay Server is injected upstream to Soloist verbatim, giving the Relay Server full
control (like a Downstream Client holding the Auth Token, not the Read-only Token). A
single optional `Authorization` header value is sent verbatim on the outbound upgrade.
Loop-safe by construction: injected frames never re-enter the observer fan-out. Trust is
the operator's — they chose the address.
_Avoid_: bridge (the audio path — see Audio Route), Webhook (one-way HTTP, event subset),
Proxy (the inbound auth front), mirror (implies read-only; the Relay has control).

**Config File**:
Our own YAML config (Soloist has no native config file) — the single source of truth for
all settings: Soloist args, Proxy listen address, tokens, web credentials, webhooks, the
Snapserver stream name (Docker), the Audio Outputs, and the Overlay Config. Both
hand-editable (bind-mounted in Docker at `/config/config.yaml`) and UI-editable via the
Landing Page, which writes it back preserving comments. No environment-variable
configuration: no `${VAR}` interpolation and no env overrides — the file is authoritative.
Path set by the `--config` flag (default `./config.yaml`). See ADR-0010.
_Avoid_: settings, manifest, env.

**Landing Page** (Web UI):
The authenticated web app the Proxy serves on its own HTTP port (the same port as the
control WebSocket). Behind a Web Session it shows the Soloist WebSocket details and
current (non-secret) configuration, links to Snapweb, lists and configures Webhooks,
edits the Relay and shows its live connection status, gives playback status and basic
controls, and edits the Overlay Config. A top-right Menu holds the light/dark toggle,
logout, a link to the Debug Page, and live status entries (Soloist, Client Count, Relay,
Webhook Status). It never renders secrets — only whether each is set.
_Avoid_: dashboard, admin panel, control socket (that is the Soloist WebSocket).

**Menu** (Landing Page):
The top-right dropdown in the Landing Page's top bar. Holds the light/dark toggle, a
link to the Debug Page, logout, and — below a divider — live status entries: Soloist
(process/link/login), Client Count, Relay connection, and Webhook Status. Its trigger
carries a worst-of-state badge dot so a problem is visible without opening it. The status
entries are fed by the Proxy Status frame over the App-Control WebSocket, so they update
without polling.
_Avoid_: navbar (that is the page-tab row), settings.

**Debug Page** (Landing Page):
An operator-only Landing Page view for diagnostics. Shows three things live: the pure
Soloist→downstream frame stream (output only — no client input, no Proxy-originated
frames), the list of connected Downstream Clients (each with remote address, tier, auth
method, uptime, and user-agent), and the Webhook Delivery History. All of it arrives over
the App-Control WebSocket.
_Avoid_: console, admin panel.

**Web Session**:
A signed, HttpOnly cookie proving a browser logged in to the Landing Page with the
web username/password (from the Config File). Gates the Landing Page, its config/control
API, and control-tier WebSocket upgrades from the browser. Separate from the Auth Token
(programmatic clients) and the Read-only Token (the overlay).
_Avoid_: Auth Token, API Key, login (Spotify Login is a different thing).

**Setup Page** (first-run):
An unauthenticated page the Proxy serves when the Config File has no web credentials (a
fresh install). It sets the web username and password only, then writes the Config File;
from then on the Landing Page login applies and the Setup Page disappears. While in this
state the Proxy serves nothing else (fails closed) and Soloist is not started until the
operator configures it in the Landing Page. See ADR-0010.
_Avoid_: Landing Page (that is the authenticated app), wizard, installer.

**Read-only Token**:
A second Proxy token, distinct from the Auth Token. A connection presenting it may
observe frames but the Hub drops any client→upstream frame from it — no commands. It is
embedded server-side in the (unauthenticated) Lyrics Overlay page so the overlay can read
playback without holding control. Anyone who can reach the overlay can read it and thus
observe now-playing; that is accepted, since it grants observation only.
_Avoid_: Auth Token (that grants control), password.

**Lyrics Overlay**:
An unauthenticated browser page the Proxy serves that renders time-synced lyrics for the
current track over a transparent background (for a stream/game overlay). It reads playback
from the Proxy WebSocket with the Read-only Token, fetches synced lyrics client-side from
lrclib.net, and styles itself from the Overlay Config.
_Avoid_: overlay (generic), builder (that is the authenticated editor in the Landing Page).

**Overlay Config**:
The global styling settings for the Lyrics Overlay (font, size, colours, effect,
alignment, timing offset, line count, anchor). A section of the Config File. Edited via
the Landing Page (authenticated); the Proxy embeds only this subset plus the Read-only
Token into the served Lyrics Overlay HTML — the overlay never reads the Config File itself.
_Avoid_: settings.

**Webhook Status**:
The single most-recent Webhook delivery outcome (last HTTP status and when), surfaced as
a live entry in the Menu. Derived from the newest entry of the Webhook Delivery History.
Reset on restart; observed delivery history, not an active health probe.
_Avoid_: Webhook (that is the outbound POST itself), health check.

**Webhook Delivery History**:
A runtime, in-memory ring buffer of the last ten Webhook deliveries the Hub records as it
fires, shown on the Debug Page. Each entry holds the event type, destination URL, HTTP
status, round-trip time, request headers (with the `Authorization` secret redacted),
response headers, and response body (size-capped). Lost on restart; best-effort, like the
Webhook itself.
_Avoid_: Webhook Status (that is only the newest entry's outcome), log, audit trail.

**Client Count**:
The number of Downstream Clients currently connected to the Proxy (control and read-only
tiers), including the viewer's own browser connection. A live Menu entry; the Debug Page
lists the same connections in full. Debug Subscribers are not counted.
_Avoid_: connections (generic — this excludes the App-Control WebSocket and the Relay).

**App-Control WebSocket**:
A second, session-gated WebSocket the Landing Page opens alongside the Soloist data
stream — the Proxy's own operator channel, kept strictly separate so the Soloist data
stream stays pure (Soloist frames verbatim, auth only). It always carries the Proxy
Status frame; a Debug Page additionally subscribes to the live frame mirror, Client list,
and Webhook Delivery History over it. Only a browser holding a Web Session may open it.
_Avoid_: Soloist data stream / control WebSocket (that is the `/` Downstream Client
stream), Relay (an outbound bridge, not an operator channel).

**Debug Subscriber**:
A connection on the App-Control WebSocket. It observes (Proxy Status, and on request the
frame mirror, Client list, and Webhook Delivery History) but is never a Downstream Client:
it is not counted in the Client Count, never appears in the Client list, and can never
send a frame to the Soloist WebSocket.
_Avoid_: Downstream Client (that consumes the Soloist data stream and may hold control).

**Proxy Status**:
A Proxy-originated telemetry frame pushed periodically over the App-Control WebSocket
(never over the Soloist data stream): Soloist process/link/login state, Client Count,
Relay status, and the newest Webhook Status. It feeds the Menu's status entries and badge.
_Avoid_: Webhook Status (one field of it), health check (this is pushed state, not a probe).

**Snapweb**:
Snapcast's own built-in web UI, served by Snapserver on its web port (`1780`) in the
Docker image. The Landing Page only links to it; the Proxy does not proxy it.
_Avoid_: Snapserver (that is the process), Web UI (that is our Landing Page).
