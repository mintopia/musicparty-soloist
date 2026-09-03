#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_PATH, ensureSecrets, loadConfig } from "./config.js";
import { serveProxy } from "./proxy.js";
import { supervise, Aborted, SoloistControl } from "./supervisor.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
    },
  });

  const configPath = values.config ?? DEFAULT_CONFIG_PATH;
  let cfg;
  try {
    cfg = loadConfig(configPath);
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

  const control = new SoloistControl();
  const sup = supervise(cfg, { signal: controller.signal, control });
  const prx = serveProxy(cfg, configPath, controller.signal, control);

  try {
    await Promise.race([sup, prx]);
  } finally {
    controller.abort();
  }

  const results = await Promise.allSettled([sup, prx]);
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
