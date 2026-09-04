# Standalone (npx) mode vs. Docker managed-audio mode is an explicit flag

The image deployment (ADR-0011) has the Proxy own a Snapcast + hardware-sink fan-out: on
boot and on every save it links `soloist-sink:monitor` to the configured Audio Outputs,
serves `GET /api/pipewire-sinks`, and drives the Audio Route UI. That whole path assumes the
container's PipeWire graph (a `soloist-sink` null-sink, WirePlumber, a pipewire-enabled
Snapserver) and is Docker-only.

We also ship a standalone deliverable — `npx @mintopia/musicparty-soloist` (bin
`soloist-proxy`). It should run Soloist, the web UI, lyrics, webhooks, the authenticated
control WebSocket, and the WebSocket relay, but **not** Snapcast or the fan-out. Instead the
operator optionally names a PipeWire device and Soloist outputs straight to it.

Previously "Docker mode" was **inferred** from the presence of the `--pipewire-device` flag,
because only the container's s6 run script passed it (to pin Soloist to `soloist-sink`). That
inference now breaks: a standalone user wants to pass `--pipewire-device` too — to choose
their own output device — without turning on a Snapcast fan-out that has nothing to link.

So the mode is now **explicit**. The container's s6 run script passes `--docker`; standalone
does not. `isDockerMode()` reads that flag, not the device pin. `--pipewire-device` reverts to
its plain meaning in both modes — "the node Soloist outputs to" — layered under
`soloist.pipewire_device` (config wins), so a standalone operator can set the device from the
Config File or the Settings page instead of a flag.

## Consequences

- `main.js` gains a boolean `--docker`. `setDockerMode()` replaces the
  `--pipewire-device`-presence heuristic behind `isDockerMode()`.
- Docker-only work is gated on `isDockerMode()`: boot `reconcileOutputs` + `startSinkPolling`
  (proxy), reconcile-after-save (web), and `GET /api/pipewire-sinks` (404 in standalone).
- The SPA hides the Audio Route tab and the Snapweb link when the config summary reports
  `dockerMode: false`, and exposes an optional **PipeWire output device** field on Settings
  (bound to `soloist.pipewire_device`, restart-to-apply). "Unknown" (pre-load) is treated as
  Docker so the existing container UI never flickers.
- No config-schema change: `soloist.pipewire_device` already existed and already flows to
  `buildArgv`. `soloist-sink` stays out of the Config File (ADR-0010/0011) — it is a container
  flag, now paired with `--docker`.
- Standalone audio out requires PipeWire on the host; with no device set, Soloist uses its
  default sink.
