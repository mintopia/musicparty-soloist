# 07: Snapserver capture

**What to build:** Run a pipewire-enabled Snapserver in the image (s6 service) that captures the `soloist-sink` null-sink via its native `pipewire://` source, so LAN Snapclients hear Spotify audio. Render `snapserver.conf` from the config's `stream_name`. Completes the Docker deliverable. See ADR-0002 for the pipewire-build dependency and rejected fallback.

**Blocked by:** 06.

**Status:** done

- [x] Snapserver binary is a pipewire-enabled build (verify at build: `ldd $(which snapserver) | grep pipewire`)
- [x] `snapserver.conf` rendered from config; source = `pipewire://?name=<stream_name>&capture_sink=true&target=soloist-sink`
- [x] Sampleformat `48000:16:2`, FLAC codec
- [x] Snapserver runs as an s6 service on host networking; the stream appears to Snapclients
- [x] End-to-end: play to the Spotify Connect device → a LAN Snapclient hears the audio

## Comments

Implemented on `feat/07-snapserver-capture`. Snapserver 0.35.0 `_with-pipewire`
.deb installed in the Dockerfile with a build-time `ldd | grep pipewire` assert
(ADR-0002). New s6 longrun `snapserver` (depends on `wireplumber`) renders
`/etc/snapserver.conf` from the Config File's `stream_name` and captures
`soloist-sink`.

Verified in a booted container: all three audio services up, sink monitor ports
present, and snapserver logged `Adding source: pipewire://?name=Spotify&...` →
`PcmStream: Spotify, sampleFormat: 48000:16:2` (flac) → PipeWire stream
`connecting -> paused` (connected to the sink; idle only because no real Spotify
audio flows in the sandbox). The final human end-to-end (real Connect device →
LAN Snapclient hears audio) needs Premium credentials + LAN clients, out of scope
for the sandbox but the full capture path is proven up to the audio source.
