# 06: PipeWire null-sink + Soloist audio routing

**What to build:** Add PipeWire to the Docker image as an s6 service, create a named null-sink (`soloist-sink`) at startup, and run Soloist with `--pipewire-device soloist-sink` so its audio lands in that sink rather than a default device. The null-sink is the stable anchor the Snapserver capture (ticket 07) will target.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] PipeWire runs as an s6 service inside the container
- [ ] A null-sink named `soloist-sink` is created reliably at startup
- [ ] Soloist is launched with `--pipewire-device soloist-sink`
- [ ] Verifiable: `pw-dump` / `pw-cli` shows Soloist playing into `soloist-sink` during playback
