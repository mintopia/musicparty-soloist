import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { DEFAULT_SNAPSERVER_CONFIG, loadConfig, type Config } from "./config.js";
import { makeLog } from "./log.js";

const log = makeLog("snapserver");

export const SNAPSERVER_CONF_PATH = "/etc/snapserver.conf";
const SNAPSERVER_SERVICE = "/run/service/snapserver";
const S6_SVC = "/command/s6-svc";

export function snapStreamSource(cfg: Config): string {
  return `source = pipewire://?name=${cfg.streamName}&sampleformat=48000:16:2&codec=flac&capture_sink=true&target=soloist-sink`;
}

// Guard the default fallback here too (parseConfig already applies it) so a direct caller
// can never render a blank file that would wedge snapserver.
export function renderSnapserverConf(cfg: Config): string {
  const tmpl = cfg.snapcastServerConfig || DEFAULT_SNAPSERVER_CONFIG;
  return tmpl
    .replaceAll("{{stream}}", snapStreamSource(cfg))
    .replaceAll("{{snapweb}}", cfg.snapweb ? "true" : "false");
}

export function snapcastNeedsRestart(cfg: Config): boolean {
  let current: string;
  try {
    current = readFileSync(SNAPSERVER_CONF_PATH, "utf8");
  } catch {
    return false;
  }
  return renderSnapserverConf(cfg) !== current;
}

export function writeSnapserverConf(cfg: Config, path: string = SNAPSERVER_CONF_PATH): void {
  writeFileSync(path, renderSnapserverConf(cfg));
}

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

export function renderConfToFileFromPath(configPath: string, outPath: string = SNAPSERVER_CONF_PATH): void {
  writeSnapserverConf(loadConfig(configPath), outPath);
}
