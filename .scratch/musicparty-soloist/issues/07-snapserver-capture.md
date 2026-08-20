# 07: Snapserver capture

**What to build:** Run a pipewire-enabled Snapserver in the image (s6 service) that captures the `soloist-sink` null-sink via its native `pipewire://` source, so LAN Snapclients hear Spotify audio. Render `snapserver.conf` from the config's `stream_name`. Completes the Docker deliverable. See ADR-0002 for the pipewire-build dependency and rejected fallback.

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] Snapserver binary is a pipewire-enabled build (verify at build: `ldd $(which snapserver) | grep pipewire`)
- [ ] `snapserver.conf` rendered from config; source = `pipewire://?name=<stream_name>&capture_sink=true&target=soloist-sink`
- [ ] Sampleformat `48000:16:2`, FLAC codec
- [ ] Snapserver runs as an s6 service on host networking; the stream appears to Snapclients
- [ ] End-to-end: play to the Spotify Connect device → a LAN Snapclient hears the audio
