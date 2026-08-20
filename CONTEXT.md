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
Our Python WebSocket server that sits in front of the Soloist WebSocket. Its only
job is authentication: it gates connections on a shared token, then transparently
relays frames both ways. No message rewriting.
_Avoid_: gateway, bridge (bridge means the audio path — see Snapcast).

**Auth Token**:
A single shared secret. A Downstream Client presents it as `Authorization: Bearer
<token>` or `?token=<token>`; a bad/missing token is rejected 401 at the WS upgrade.
_Avoid_: API key (that is the Spotify API Key — a different thing), password.

**API Key**:
The Spotify-for-Developers private key passed to Soloist as `--api-key`. Ties the
daemon to a Premium account; it is the daemon's auth (no separate interactive
pairing step is used). Supplied via env/config, never committed.
_Avoid_: Auth Token (that gates our Proxy), Spotify credentials, secret.

**Downstream Client**:
A remote consumer that connects to the Proxy to observe playback and send commands.
_Avoid_: user, subscriber.

**Audio Route** (Docker only):
Soloist plays into a PipeWire null-sink; Snapserver captures that sink via its
native `pipewire://` source (`capture_sink=true`, `48000:16:2`, FLAC). Requires a
pipewire-enabled Snapserver build. No FIFO, no external capture process. The
null-sink is the stable anchor between the two.
_Avoid_: FIFO, pipe, bridge.

**Snapserver**:
The Snapcast server, run inside the Docker image on host networking so LAN clients
reach it. Its stream name is operator-configurable.
_Avoid_: snapcast (that is the project/protocol; the process is snapserver).

**Config File**:
Our own YAML config (Soloist has no native config file). Holds Soloist settings,
Proxy listen address, the Auth Token, and (Docker only) the Snapserver stream name.
Every value is env-overridable; env wins.
_Avoid_: settings, manifest.
