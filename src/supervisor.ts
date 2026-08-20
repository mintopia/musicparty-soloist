// Supervise the Soloist daemon.
//
// Launch `soloist` with the local control WebSocket (-w), device name, API Key,
// data-dir, and any extra_args — this is what makes the Connect device appear.
// Then keep it running:
//   - exit 10 (build expired): re-acquire the binary and restart now.
//   - other non-zero: log and restart with capped exponential backoff.
//   - exit 0 (clean shutdown): stop; do not loop.
//
// Abort the passed signal to shut down; the child is terminated (SIGTERM, then
// SIGKILL on timeout) on the way out.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireSoloist } from "./acquire.js";
import type { Config } from "./config.js";

export const EXIT_EXPIRED = 10;
export const BACKOFF_BASE = 1.0;
export const BACKOFF_MAX = 60.0;
export const HEALTHY_SECONDS = 60.0; // a run this long is "healthy" — reset backoff
export const TERM_TIMEOUT = 10.0;

// Sentinel thrown out of the run loop when the supervise signal is aborted.
export class Aborted extends Error {}

const log = (msg: string, ...args: unknown[]) =>
  console.log(`${new Date().toISOString()} soloist.supervisor ${msg}`, ...args);

// Assemble the Soloist command line from the binary path and config.
export function buildArgv(binary: string, cfg: Config): string[] {
  const argv = [
    "-w", cfg.soloistWs,
    "--device-name", cfg.soloist.deviceName,
    "--api-key", cfg.soloist.apiKey,
    "--data-dir", cfg.soloist.dataDir,
  ];
  if (cfg.soloist.pipewireDevice) argv.push("--pipewire-device", cfg.soloist.pipewireDevice);
  argv.push(...cfg.soloist.extraArgs);
  return argv;
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

// Run soloist once; resolve with its exit code, or throw Aborted if the signal
// fires first (after terminating the child).
function runOnce(binary: string, cfg: Config, signal: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(binary, buildArgv(binary, cfg), { stdio: "inherit" });
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
}

// Run the Soloist daemon under supervision until it exits cleanly (returns 0) or
// the signal is aborted (throws Aborted). Never returns on crashes — it restarts.
// Binary cache dir / download base come from $SOLOIST_CACHE_DIR / $SOLOIST_DOWNLOAD_BASE.
export async function supervise(cfg: Config, opts: SuperviseOptions = {}): Promise<number> {
  const { signal = new AbortController().signal } = opts;

  mkdirSync(cfg.soloist.dataDir, { recursive: true });
  let binary = await acquireSoloist();
  let backoff = BACKOFF_BASE;

  while (true) {
    if (signal.aborted) throw new Aborted();
    log("starting soloist: device=%s ws=%s data-dir=%s", cfg.soloist.deviceName, cfg.soloistWs, cfg.soloist.dataDir);
    const started = Date.now();
    const code = await runOnce(binary, cfg, signal);
    const ran = (Date.now() - started) / 1000;

    if (code === 0) {
      log("soloist exited cleanly (0) after %ds; not restarting", Math.round(ran));
      return code;
    }
    if (code === EXIT_EXPIRED) {
      log("soloist build expired (exit 10); re-acquiring binary");
      binary = await acquireSoloist(undefined, { force: true });
      backoff = BACKOFF_BASE;
      continue; // restart immediately on a fresh binary
    }
    if (ran >= HEALTHY_SECONDS) backoff = BACKOFF_BASE; // crash after healthy run — reset
    log("soloist exited with code %d after %ds; restarting in %ss", code, Math.round(ran), backoff);
    await sleep(backoff * 1000);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }
}
