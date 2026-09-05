// Boot-time deployment runtime flags, set once from main's argv and read across the
// Proxy. They live here rather than on the supervisor because deployment mode and the
// output-device pin are process-wide deployment concerns, not supervisor state — web.ts
// and proxy.ts read them without pulling in the supervisor.

// Docker mode = the managed-audio deployment (ADR-0011/0015): the Proxy owns a Snapcast +
// hardware-sink fan-out and serves the Audio Route UI. Set explicitly by the container's
// s6 run script (--docker). Standalone (npx) leaves it false: no Snapcast, no fan-out —
// Soloist outputs straight to its optional --pipewire-device / soloist.pipewire_device.
let dockerMode = false;
export function setDockerMode(on: boolean): void {
  dockerMode = on;
}
export function isDockerMode(): boolean {
  return dockerMode;
}

// A --pipewire-device flag pins Soloist's output node. In Docker it's the soloist-sink
// null-sink (the fan-out anchor, ADR-0011); in standalone it's an optional user-supplied
// device (ADR-0015). It comes from a main.js flag rather than cfg, so it stays out of
// buildArgv's persisted round-trip — though cfg.soloist.pipewireDevice still wins over it
// when both are set.
let pipewireDeviceOverride = "";
export function setPipewireDeviceOverride(name: string): void {
  pipewireDeviceOverride = name.trim();
}
export function getPipewireDeviceOverride(): string {
  return pipewireDeviceOverride;
}
