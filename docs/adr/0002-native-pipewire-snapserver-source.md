# Snapserver captures audio via its native `pipewire://` source

In the Docker image, Soloist plays into a PipeWire null-sink (`soloist-sink`) and
Snapserver captures it with `source = pipewire://?name=<stream>&capture_sink=true&target=soloist-sink`
(`48000:16:2`, FLAC). This needs a **pipewire-enabled Snapserver build**
(`BUILD_WITH_PIPEWIRE=ON`) — off in default packages, so the image must install the
`*_with-pipewire` variant. Verify at build with `ldd $(which snapserver) | grep pipewire`.

## Considered Options

- **`pipe:///tmp/snapfifo` + a supervised `pw-cat`/`parec` feeder**: rejected —
  works on any Snapserver build but adds a second long-lived process to supervise,
  a FIFO, and manual sampleformat matching. More moving parts for no gain once the
  pipewire build is present.
- **`alsa` source via PipeWire's ALSA compat**: rejected — least documented, most
  fragile (extra `asound.conf` mapping layer).

## Consequences

The image is pinned to a Snapserver build that carries the PipeWire dependency. If a
future base image lacks it, fall back to the `pipe` + feeder approach above rather
than shipping a broken `pipewire://` source silently.
