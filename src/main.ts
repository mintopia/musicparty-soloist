#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.js";
import { serveProxy } from "./proxy.js";
import { supervise, Aborted } from "./supervisor.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
    },
  });

  let cfg;
  try {
    cfg = loadConfig(values.config);
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

  const sup = supervise(cfg, { signal: controller.signal });
  const prx = serveProxy(cfg, controller.signal);

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
