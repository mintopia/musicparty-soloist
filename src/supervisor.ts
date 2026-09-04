import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireSoloist } from "./acquire.js";
import { soloistReady, type Config } from "./config.js";
import { makeLog } from "./log.js";

export const EXIT_EXPIRED = 10;
export const BACKOFF_BASE = 1.0;
export const BACKOFF_MAX = 60.0;
export const HEALTHY_SECONDS = 60.0;
export const TERM_TIMEOUT = 10.0;

export class Aborted extends Error {}

const log = makeLog("supervisor");

// ponytail: module-global set once at boot. Docker pins Soloist's output to the
// soloist-sink null-sink (the fan-out anchor, ADR-0011) via --pipewire-device; the
// Config File must not carry it (soloist-sink is Docker infra, not user config, and
// config.example.yaml is shared with standalone), so it comes from a main.js flag
// instead of cfg — and stays out of buildArgv's persisted round-trip.
let pipewireDeviceOverride = "";
export function setPipewireDeviceOverride(name: string): void {
  pipewireDeviceOverride = name.trim();
}

// The --pipewire-device override is set only by the Docker s6 run script (ADR-0011),
// so its presence is the reliable "running in the container" signal.
export function isDockerMode(): boolean {
  return pipewireDeviceOverride !== "";
}

export function buildArgv(cfg: Config): string[] {
  const argv = [
    "-w", cfg.soloistWs,
    "--device-name", cfg.soloist.deviceName,
    "--api-key", cfg.soloist.apiKey,
    "--data-dir", cfg.soloist.dataDir,
  ];
  // An explicit config value wins; otherwise fall back to the Docker pin.
  const device = cfg.soloist.pipewireDevice || pipewireDeviceOverride;
  if (device) argv.push("--pipewire-device", device);
  argv.push(...cfg.soloist.extraArgs);
  return argv;
}

// Shared handle between the supervisor loop and the web API: tracks what Soloist
// was last spawned with (so the UI can show a "restart to apply" banner) and lets
// POST /api/restart-soloist abort just the current iteration (Proxy stays up).
export class SoloistControl {
  private appliedArgv: string | null = null;
  private iter: AbortController | null = null;

  bindIteration(ac: AbortController): void {
    this.iter = ac;
  }

  markApplied(cfg: Config): void {
    this.appliedArgv = JSON.stringify(buildArgv(cfg));
  }

  // True once Soloist is running and the live config's Soloist args (device name,
  // API Key, soloist_ws, ...) differ from what that process was started with.
  pendingRestart(cfg: Config): boolean {
    return this.appliedArgv !== null && this.appliedArgv !== JSON.stringify(buildArgv(cfg));
  }

  // Abort the current supervise iteration so the loop re-spawns Soloist with the
  // live config; optimistically clears pending since the respawn uses this cfg.
  restart(cfg: Config): void {
    this.markApplied(cfg);
    this.iter?.abort();
  }
}

async function terminate(proc: ChildProcess, timeout = TERM_TIMEOUT): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const timer = sleep(timeout * 1000).then(() => "timeout" as const);
  const winner = await Promise.race([exited.then(() => "exited" as const), timer]);
  if (winner === "timeout") {
    proc.kill("SIGKILL");
    await exited;
  }
}

function runOnce(binary: string, cfg: Config, signal: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(binary, buildArgv(cfg), { stdio: "inherit" });
    const onAbort = () => {
      log("shutdown requested; terminating soloist (pid %s)", proc.pid);
      terminate(proc).then(() => reject(new Aborted()), reject);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    proc.once("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    proc.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (!signal.aborted) resolve(code ?? 0);
    });
  });
}

export interface SuperviseOptions {
  signal?: AbortSignal;
  control?: SoloistControl;
  acquire?: (force?: boolean) => Promise<string>;
}

export async function supervise(cfg: Config, opts: SuperviseOptions = {}): Promise<number> {
  const {
    signal = new AbortController().signal,
    control,
    acquire = (force = false) => acquireSoloist(undefined, { force }),
  } = opts;

  // First-run setup / incomplete config: don't spawn until minimally valid. The
  // Setup Page and PUT /api/config mutate cfg in place, so poll it — readiness
  // flips at most once and config edits are human-driven.
  // ponytail: 1s poll, no event bus; upgrade to a notifier only if this ever needs
  // to be instant.
  for (let logged = false; !soloistReady(cfg); ) {
    if (signal.aborted) throw new Aborted();
    if (!logged) { log("waiting for config: web creds + Soloist args (device name, API key)"); logged = true; }
    await sleep(1000);
  }

  mkdirSync(cfg.soloist.dataDir, { recursive: true });
  let binary = await acquire();
  let backoff = BACKOFF_BASE;

  while (true) {
    if (signal.aborted) throw new Aborted();

    // Per-iteration abort: fired by global shutdown OR by control.restart(). A
    // restart aborts just this run and the loop re-spawns; shutdown propagates.
    const iter = new AbortController();
    const onShutdown = () => iter.abort();
    signal.addEventListener("abort", onShutdown, { once: true });
    control?.bindIteration(iter);
    control?.markApplied(cfg);

    log("starting soloist: device=%s ws=%s data-dir=%s", cfg.soloist.deviceName, cfg.soloistWs, cfg.soloist.dataDir);
    const started = Date.now();
    let code: number;
    try {
      code = await runOnce(binary, cfg, iter.signal);
    } catch (err) {
      signal.removeEventListener("abort", onShutdown);
      if (err instanceof Aborted && !signal.aborted) {
        log("restart requested; re-spawning soloist");
        backoff = BACKOFF_BASE;
        continue;
      }
      throw err;
    }
    signal.removeEventListener("abort", onShutdown);
    const ran = (Date.now() - started) / 1000;

    // Exit 0 = Soloist self-quit (our shutdown throws Aborted instead); restart so the container never runs playerless.
    if (code === EXIT_EXPIRED) {
      log("soloist build expired (exit 10); re-acquiring binary");
      binary = await acquire(true);
      backoff = BACKOFF_BASE;
      continue;
    }
    if (ran >= HEALTHY_SECONDS) backoff = BACKOFF_BASE;
    log("soloist exited with code %d after %ds; restarting in %ss", code, Math.round(ran), backoff);
    await sleep(backoff * 1000);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }
}
