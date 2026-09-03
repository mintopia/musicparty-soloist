#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_PATH, defaultConfig, ensureSecrets, loadConfig, soloistReady } from "./config.js";
import { serveProxy } from "./proxy.js";
import { supervise, Aborted, SoloistControl } from "./supervisor.js";
import { makeLog } from "./log.js";

const log = makeLog("main");

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
    },
  });

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

  // The Proxy HTTP/WS server always starts; Soloist is supervised only once web creds
  // and Soloist args are present. Otherwise we serve the Setup Page and wait (T3).
  const control = new SoloistControl();
  const prx = serveProxy(cfg, configPath, controller.signal, control);
  const tasks: Promise<unknown>[] = [prx];
  if (soloistReady(cfg)) {
    tasks.push(supervise(cfg, { signal: controller.signal, control }));
  } else {
    log("first-run setup mode: web creds/Soloist args incomplete — serving Setup Page, Soloist not started");
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
