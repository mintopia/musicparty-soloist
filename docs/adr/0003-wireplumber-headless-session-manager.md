# WirePlumber (headless, private dbus) is the PipeWire session manager

The null-sink (`soloist-sink`) is defined statically in a `pipewire.conf.d` drop-in,
so the PipeWire daemon creates the *node* on its own. But a bare adapter node has no
DSP ports and nothing links to it until a **session manager** configures it. So the
image also runs **WirePlumber**, which creates `soloist-sink`'s `playback_FL/FR`
ports and links any client that targets the sink (Soloist via `--pipewire-device`,
Snapserver via `target=soloist-sink`).

Making WirePlumber survive in a bare container took three fixes, each guarding a
plugin that assumes a desktop it does not have:

- **Disable the bluez monitor** (`/etc/wireplumber/bluetooth.lua.d/80-disable-bluez.lua`).
  It pulls in the systemd-logind plugin, which aborts WirePlumber (exit 70) when there
  is no logind. We route no Bluetooth, so it is dead weight.
- **Run under a private dbus session** (`dbus-run-session -- wireplumber`). The
  `reserve-device` and `portal-permissionstore` plugins need a session bus; there is
  no system bus in the container.
- **Generate `/etc/machine-id`** at build so that private bus can start.

## Considered Options

- **Static links in `pipewire.conf` instead of a session manager**: rejected — the
  client node names are dynamic (Soloist/Snapserver connect at runtime), so there is
  no fixed port to pre-link, and the adapter still needs a manager to gain ports.
- **A full system dbus + logind**: rejected — far more moving parts to supervise for
  plugins we actively don't want (device reservation, seat arbitration).

## Consequences

`dbus` is a build dependency of an "audio" image, which looks odd until you know
WirePlumber needs a bus. The libcamera/v4l2 monitors still log benign "not supported"
warnings — harmless, left alone.

## Amendment (WirePlumber 0.5, trixie base)

The base image now ships WirePlumber 0.5, so the predicted Lua-drop-in change landed:

- The bluez disable moved from `bluetooth.lua.d/80-disable-bluez.lua` to the SPA-JSON
  `wireplumber.conf.d/80-disable-bluez.conf`.
- WP 0.5's policy classifies Snapserver's `capture_sink` node as an `Audio/Sink` device,
  not a capture client, so it is **no longer auto-linked** to the null-sink monitor and
  the stream stays silent. The snapserver service now `pw-link`s `soloist-sink:monitor_FL/FR`
  to the capture node's `playback_FL/FR` explicitly, once those ports appear. Soloist's
  own playback node still auto-links as before.
