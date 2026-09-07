import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireSoloist } from "./acquire.js";
import { soloistReady, type Config } from "./config.js";
import { makeLog } from "./log.js";
import { getPipewireDeviceOverride } from "./runtime.js";
import { deferred } from "./util.js";
import type { SoloistState } from "./wire-contract.js";

export const EXIT_EXPIRED = 10;
export const BACKOFF_BASE = 1.0;
export const BACKOFF_MAX = 60.0;
export const HEALTHY_SECONDS = 60.0;
export const TERM_TIMEOUT = 10.0;

export class Aborted extends Error {}

export type { SoloistState } from "./wire-contract.js";

export function backoffStep(current: number, ranSeconds: number): { sleep: number; next: number } {
  const wait = ranSeconds >= HEALTHY_SECONDS ? BACKOFF_BASE : current;
  return { sleep: wait, next: Math.min(wait * 2, BACKOFF_MAX) };
}

const log = makeLog("supervisor");

export function buildArgv(cfg: Config): string[] {
  const argv = [
    "-w", cfg.soloistWs,
    "--device-name", cfg.soloist.deviceName,
    "--api-key", cfg.soloist.apiKey,
    "--data-dir", cfg.soloist.dataDir,
  ];
  const device = cfg.soloist.pipewireDevice || getPipewireDeviceOverride();
  if (device) argv.push("--pipewire-device", device);
  argv.push(...cfg.soloist.extraArgs);
  return argv;
}

export class SoloistControl {
  private appliedArgv: string | null = null;
  private iter: AbortController | null = null;
  private state: SoloistState = "waiting";
  private wake = deferred();

  bindIteration(ac: AbortController): void {
    this.iter = ac;
  }

  // Crash-loop backoff sleep that returns early when restart() fires or `signal`
  // aborts, so a queued restart (or shutdown) during the wait isn't held off until
  // the backoff cap — iter is already spent once the run has exited, so the sleep,
  // not the iteration abort, is what a restart must interrupt here.
  async backoffSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const onAbort = () => this.signalWake();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([sleep(ms), this.wake.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private signalWake(): void {
    this.wake.resolve();
    this.wake = deferred();
  }

  setState(state: SoloistState): void {
    this.state = state;
  }

  soloistStatus(): { state: SoloistState } {
    return { state: this.state };
  }

  markApplied(cfg: Config): void {
    this.appliedArgv = JSON.stringify(buildArgv(cfg));
  }

  pendingRestart(cfg: Config): boolean {
    return this.appliedArgv !== null && this.appliedArgv !== JSON.stringify(buildArgv(cfg));
  }

  restart(cfg: Config): void {
    this.markApplied(cfg);
    this.iter?.abort();
    this.signalWake();
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

function runOnce(binary: string, cfg: Config, signal: AbortSignal, onSpawn?: () => void): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(binary, buildArgv(cfg), { stdio: "inherit" });
    if (onSpawn) proc.once("spawn", onSpawn);
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
    acquire = (force = false) => acquireSoloist(undefined, { force, signal }),
  } = opts;

  // The loop only ever exits by throwing (shutdown Aborted or an unrecoverable
  // error); either way Soloist is no longer supervised, so the terminal state is
  // stopped. A restart stays inside the loop and never reaches finally.
  try {
  control?.setState("waiting");

  // First-run setup / incomplete config: don't spawn until minimally valid. The
  // Setup Page and PUT /api/config mutate cfg in place, so poll it — readiness
  // flips at most once and config edits are human-driven.
  for (let logged = false; !soloistReady(cfg); ) {
    if (signal.aborted) throw new Aborted();
    if (!logged) { log("waiting for config: web creds + Soloist args (device name, API key)"); logged = true; }
    await sleep(1000);
  }

  mkdirSync(cfg.soloist.dataDir, { recursive: true });
  control?.setState("acquiring");

  const acquireWithRetry = async (force: boolean): Promise<string> => {
    let backoff = BACKOFF_BASE;
    while (true) {
      if (signal.aborted) throw new Aborted();
      try {
        return await acquire(force);
      } catch (err) {
        if (signal.aborted) throw new Aborted();
        const { sleep: waitS, next } = backoffStep(backoff, 0);
        log.error("soloist acquisition failed (%s); retrying in %ss", (err as Error).message, waitS);
        control?.setState("backoff");
        try {
          await sleep(waitS * 1000, undefined, { signal });
        } catch {
          throw new Aborted();
        }
        backoff = next;
        control?.setState("acquiring");
      }
    }
  };

  let binary = await acquireWithRetry(false);
  let backoff = BACKOFF_BASE;

  while (true) {
    if (signal.aborted) throw new Aborted();
    control?.setState("starting");

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
      code = await runOnce(binary, cfg, iter.signal, () => control?.setState("running"));
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
      control?.setState("expired-reacquiring");
      binary = await acquireWithRetry(true);
      backoff = BACKOFF_BASE;
      continue;
    }
    const { sleep: waitS, next } = backoffStep(backoff, ran);
    log.warn("soloist exited with code %d after %ds; restarting in %ss", code, Math.round(ran), waitS);
    control?.setState("backoff");
    if (control) await control.backoffSleep(waitS * 1000, signal);
    else await sleep(waitS * 1000);
    backoff = next;
  }
  } finally {
    control?.setState("stopped");
  }
}
