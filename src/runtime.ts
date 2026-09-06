let dockerMode = false;
export function setDockerMode(on: boolean): void {
  dockerMode = on;
}
export function isDockerMode(): boolean {
  return dockerMode;
}

let pipewireDeviceOverride = "";
export function setPipewireDeviceOverride(name: string): void {
  pipewireDeviceOverride = name.trim();
}
export function getPipewireDeviceOverride(): string {
  return pipewireDeviceOverride;
}
