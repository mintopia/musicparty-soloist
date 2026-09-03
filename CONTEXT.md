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
current (non-secret) configuration, links to Snapweb, lists Webhooks and their Webhook
Status, gives playback status and basic controls, and edits the Overlay Config. It never
renders secrets — only whether each is set.
_Avoid_: dashboard, admin panel, control socket (that is the Soloist WebSocket).

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
Runtime, in-memory delivery stats the Hub records per Webhook destination as it fires:
last HTTP status, last delivery time, success/failure counts, last error. Shown on the
Landing Page next to the configured Webhooks. Reset on restart; it is observed delivery
history, not an active health probe.
_Avoid_: Webhook (that is the outbound POST itself), health check.

**Snapweb**:
Snapcast's own built-in web UI, served by Snapserver on its web port (`1780`) in the
Docker image. The Landing Page only links to it; the Proxy does not proxy it.
_Avoid_: Snapserver (that is the process), Web UI (that is our Landing Page).
