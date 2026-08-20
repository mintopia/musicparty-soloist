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
Soloist plays into a PipeWire null-sink (`soloist-sink`); Snapserver captures that
sink via its native `pipewire://` source (`capture_sink=true`, `48000:16:2`, FLAC).
Requires a pipewire-enabled Snapserver build. A headless WirePlumber (see ADR-0003)
is the session manager that gives the sink its ports and links playback clients onto it.
WirePlumber 0.5 treats Snapserver's capture node as a device, not a capture client, so it
is *not* auto-linked — the snapserver service explicitly `pw-link`s the sink monitor to it.
No FIFO, no external capture process. The null-sink is the stable anchor between the two.
_Avoid_: FIFO, pipe, bridge.

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
Our own YAML config (Soloist has no native config file). Holds Soloist settings,
Proxy listen address, the Auth Token, and (Docker only) the Snapserver stream name.
Any value is env-overridable via `${VAR}` / `${VAR:-default}` interpolation; env wins
over the file default.
_Avoid_: settings, manifest.
