#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ConfigError, DEFAULT_CONFIG_PATH, defaultConfig, ensureSecrets, loadConfig, soloistReady } from "./config.js";
import { serveProxy } from "./proxy.js";
import { supervise, Aborted, SoloistControl } from "./supervisor.js";
import { setPipewireDeviceOverride, setDockerMode } from "./runtime.js";
import { makeLog } from "./log.js";

const log = makeLog("main");

export interface MainArgs {
  config?: string;
  docker: boolean;
  pipewireDevice?: string;
}

export function parseMainArgs(args: string[]): MainArgs {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      // Managed-audio deployment (ADR-0011/0015): enable the Proxy's Snapcast + hardware
      // fan-out and the Audio Route UI. Set by the container's s6 run script; absent in
      // standalone (npx), which runs Soloist with no fan-out.
      docker: { type: "boolean" },
      // Pin Soloist's output node. Docker passes the soloist-sink null-sink; standalone
      // users may pass their own PipeWire device (optional). Not env, not persisted config.
      "pipewire-device": { type: "string" },
    },
  });
  return {
    config: values.config,
    docker: values.docker ?? false,
    pipewireDevice: values["pipewire-device"],
  };
}

export function applyRuntimeFlags(a: MainArgs): void {
  if (a.docker) setDockerMode(true);
  if (a.pipewireDevice) setPipewireDeviceOverride(a.pipewireDevice);
}

export function installShutdownHandlers(
  proc: Pick<NodeJS.Process, "on">,
  onShutdown: () => void,
): void {
  proc.on("SIGINT", onShutdown);
  proc.on("SIGTERM", onShutdown);
}

// Bound on graceful teardown before the watchdog forces exit (ARCH-L3).
export const SHUTDOWN_TIMEOUT_MS = 15_000;

export interface WatchdogDeps {
  setTimer: (cb: () => void, ms: number) => { unref: () => void };
  exit: (code: number) => void;
  log?: (msg: string) => void;
}

// serveProxy's close() awaits server.close(), which blocks on lingering keep-alive
// connections and can hang indefinitely. This force-exits after a bound so a stuck
// teardown can never wedge the process. unref so a clean shutdown isn't held open.
export function armShutdownWatchdog(timeoutMs: number, deps: WatchdogDeps): void {
  deps
    .setTimer(() => {
      deps.log?.(`graceful shutdown exceeded ${timeoutMs}ms — forcing exit`);
      deps.exit(1);
    }, timeoutMs)
    .unref();
}

async function main(): Promise<number> {
  const args = parseMainArgs(process.argv.slice(2));
  applyRuntimeFlags(args);

  const configPath = args.config ?? DEFAULT_CONFIG_PATH;
  let cfg;
  try {
    // Missing file = fresh install: boot into setup mode from defaults rather than error.
    cfg = existsSync(configPath) ? loadConfig(configPath) : defaultConfig();
    ensureSecrets(configPath, cfg);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.log(`config error: ${e.message}`);
      return 1;
    }
    throw e;
  }

  const controller = new AbortController();
  let watchdogArmed = false;
  const shutdown = () => {
    controller.abort();
    if (watchdogArmed) return;
    watchdogArmed = true;
    armShutdownWatchdog(SHUTDOWN_TIMEOUT_MS, {
      setTimer: (cb, ms) => setTimeout(cb, ms),
      exit: (code) => process.exit(code),
      log,
    });
  };
  installShutdownHandlers(process, shutdown);

  // The Proxy HTTP/WS server always starts. The supervisor also always starts but
  // parks until the config is minimally valid (web creds + Soloist args): first-run
  // setup and PUT /api/config mutate cfg in place, so completing setup starts Soloist
  // without a process restart (T3).
  const control = new SoloistControl();
  const prx = serveProxy(cfg, configPath, controller.signal, control);
  const tasks: Promise<unknown>[] = [prx, supervise(cfg, { signal: controller.signal, control })];
  if (!soloistReady(cfg)) {
    log("first-run setup mode: web creds/Soloist args incomplete — serving Setup Page, Soloist parked until configured");
  }

  try {
    await Promise.race(tasks);
  } finally {
    controller.abort();
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected" && !(r.reason instanceof Aborted)) throw r.reason;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
