# 06: PipeWire null-sink + Soloist audio routing

**What to build:** Add PipeWire to the Docker image as an s6 service, create a named null-sink (`soloist-sink`) at startup, and run Soloist with `--pipewire-device soloist-sink` so its audio lands in that sink rather than a default device. The null-sink is the stable anchor the Snapserver capture (ticket 07) will target.

**Blocked by:** 05.

**Status:** done

- [x] PipeWire runs as an s6 service inside the container
- [x] A null-sink named `soloist-sink` is created reliably at startup
- [x] Soloist is launched with `--pipewire-device soloist-sink`
- [x] Verifiable: `pw-dump` / `pw-cli` shows Soloist playing into `soloist-sink` during playback

## Comments

Implemented on `feat/06-pipewire-null-sink`.

- `soloist-sink` is defined statically in `docker/pipewire/soloist-sink.conf` (a
  `pipewire.conf.d` drop-in), so the PipeWire daemon creates it at startup — no race,
  no post-launch `pw-cli` command.
- s6 services: `pipewire` → `wireplumber` → `soloist-proxy` (dependency-ordered).
  `soloist-proxy`'s run script waits for the sink node before launching Soloist.
- Soloist gets `--pipewire-device soloist-sink` via the new `soloist.pipewire_device`
  config field (`SOLOIST_PIPEWIRE_DEVICE` env override), set in the image; the
  standalone deliverable leaves it empty and passes no flag.
- WirePlumber is the session manager that gives the sink its ports and links clients
  onto it. Making it survive headless needed dbus + a bluez/logind disable — see
  **ADR-0003**.

**Verified in the built image** (no manual setup): the sink appears with
`soloist-sink:playback_FL/FR` input ports, and a `pw-play --target soloist-sink`
stream (standing in for Soloist — both are `pw-stream` clients that target the sink)
links `pw-play:output_FL -> soloist-sink:playback_FL`. Real-Soloist playback needs a
live Spotify account and is covered by the ticket-07 end-to-end.
