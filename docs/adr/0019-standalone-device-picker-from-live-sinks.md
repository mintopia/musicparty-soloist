# Standalone picks its PipeWire output device from a live sink list, not free text

ADR-0015 gave standalone (npx) mode an optional PipeWire output device: with none set,
Soloist auto-connects to whatever sink PipeWire hands it. On a host with more than one sink
that guess is often wrong — a Raspberry Pi reports both the on-board headphone jack and a
HAT DAC as `Audio/Sink` nodes, and Soloist landed on the jack while the speakers hung off
the DAC, so playback "worked" (the stream was active) but nothing came out of the intended
device. Docker never hits this: the container pins Soloist to the `soloist-sink` null-sink
and the Proxy fans it out to operator-selected outputs.

ADR-0015 left the standalone operator two ways to name that device — a free-text
`soloist.pipewire_device` field on Settings, or `--pipewire-device` — and deliberately
**404'd `GET /api/pipewire-sinks` in standalone** because the sink endpoint was framed as
part of the Docker-only Audio Route UI. But a free-text field can't tell the operator that
`alsa_output.platform-soc_sound.stereo-fallback` is their DAC; they'd have to shell in and
run `pw-dump`. The information the picker needs already exists — it just wasn't served.

So standalone now **serves `GET /api/pipewire-sinks`** too, and Settings renders the output
device as a **dropdown** populated from it. The endpoint stays session-gated in both modes.

## Consequences

- `GET /api/pipewire-sinks` is no longer gated on `isDockerMode()`. The handler branches on
  mode instead: Docker returns the warm sink cache **with** the synthetic Snapcast toggle
  (unchanged); standalone returns `listStandaloneSinks()` — real `Audio/Sink` nodes only, on
  demand (no Snapcast entry, no Snapserver-capture exclusion, since neither exists without a
  fan-out). Both respond `{ sinks, refreshedAt }`.
- `listStandaloneSinks()` is `parseSinks(pw-dump)` with no `exclude` — no cache, no polling.
  The Settings dropdown fetches once on mount and on a manual **Refresh**; a per-request
  `pw-dump` is cheap enough at that cadence.
- Settings (standalone only) replaces the free-text field with a `<select>`: an empty
  "Soloist default (auto)" option plus one per sink (value = `node.name`, label = the sink
  description). A configured device that isn't in the live list is still shown (labelled
  "not detected") so a manual or stale `soloist.pipewire_device` is never dropped on save.
  It remains bound to `soloist.pipewire_device`, restart-to-apply — the existing pending
  banner already covers it (`buildArgv` includes the device).
- No config-schema or Docker-path change. This refines the ADR-0015 consequences that said
  the endpoint 404s in standalone and that Settings exposes a plain device field.
