// Snapserver config rendering (ADR-0020). Docker-only: the operator edits a snapserver.conf
// template in Settings; the {{stream}} and {{snapweb}} placeholders are substituted here from
// the live Config. The same renderer feeds both the s6 `snapserver` run script (at container
// start) and the Proxy's restart-on-demand, so a rendered file always matches what the Proxy
// would produce — which is how "restart Snapcast to apply" detects a pending change.

import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { DEFAULT_SNAPSERVER_CONFIG, loadConfig, type Config } from "./config.js";
import { makeLog } from "./log.js";

const log = makeLog("snapserver");

export const SNAPSERVER_CONF_PATH = "/etc/snapserver.conf";
const SNAPSERVER_SERVICE = "/run/service/snapserver";
const S6_SVC = "/command/s6-svc";

// The pipewire capture source line {{stream}} expands to: Snapserver reads soloist-sink's
// monitor as a native pipewire source (ADR-0002), named after the configured stream name.
export function snapStreamSource(cfg: Config): string {
  return `source = pipewire://?name=${cfg.streamName}&sampleformat=48000:16:2&codec=flac&capture_sink=true&target=soloist-sink`;
}

// Render the final snapserver.conf from the operator's template. An empty template falls
// back to the built-in default (parseConfig already applies that, but guard anyway so a
// direct caller never renders a blank file that would wedge snapserver).
export function renderSnapserverConf(cfg: Config): string {
  const tmpl = cfg.snapcastServerConfig || DEFAULT_SNAPSERVER_CONFIG;
  return tmpl
    .replaceAll("{{stream}}", snapStreamSource(cfg))
    .replaceAll("{{snapweb}}", cfg.snapweb ? "true" : "false");
}

// True when the rendered conf differs from what snapserver is currently running with (the
// on-disk file it was last (re)started against). Drives the "restart Snapcast to apply"
// banner. Any read failure (file absent, standalone) reports no pending change.
export function snapcastNeedsRestart(cfg: Config): boolean {
  let current: string;
  try {
    current = readFileSync(SNAPSERVER_CONF_PATH, "utf8");
  } catch {
    return false;
  }
  return renderSnapserverConf(cfg) !== current;
}

// Write the rendered conf to the path snapserver reads. Shared by the s6 run script (start)
// and restartSnapserver (apply-on-demand) so both produce byte-identical output.
export function writeSnapserverConf(cfg: Config, path: string = SNAPSERVER_CONF_PATH): void {
  writeFileSync(path, renderSnapserverConf(cfg));
}

// Re-render the conf and bounce the s6 snapserver service so the new config takes effect.
// Only the snapserver longrun restarts — Soloist, the Proxy, and PipeWire are untouched.
export function restartSnapserver(cfg: Config): Promise<void> {
  writeSnapserverConf(cfg);
  return new Promise((resolve, reject) => {
    execFile(S6_SVC, ["-r", SNAPSERVER_SERVICE], (err) => {
      if (err) {
        log.error("snapserver restart failed: %s", err.message);
        reject(err);
      } else {
        log("snapserver restarted to apply config");
        resolve();
      }
    });
  });
}

// Entry point for the s6 `snapserver` run script: load the Config File and write the conf.
// Throws on any failure so the shell caller can fall back to a safe default.
export function renderConfToFileFromPath(configPath: string, outPath: string = SNAPSERVER_CONF_PATH): void {
  writeSnapserverConf(loadConfig(configPath), outPath);
}
