#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_PATH, defaultConfig, ensureSecrets, loadConfig, soloistReady } from "./config.js";
import { serveProxy } from "./proxy.js";
import { supervise, Aborted, SoloistControl, setPipewireDeviceOverride, setDockerMode } from "./supervisor.js";
import { makeLog } from "./log.js";

const log = makeLog("main");

async function main(): Promise<number> {
  const { values } = parseArgs({
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

  if (values.docker) setDockerMode(true);
  if (values["pipewire-device"]) setPipewireDeviceOverride(values["pipewire-device"]);

  const configPath = values.config ?? DEFAULT_CONFIG_PATH;
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
  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
