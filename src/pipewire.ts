// Proxy-owned PipeWire fan-out (ADR-0011). Soloist plays into the `soloist-sink`
// null-sink; the Proxy links that sink's monitor ports to every enabled Audio
// Output on boot and on config save, and unlinks deselected ones. Snapcast is a
// synthetic output special-cased to the Snapserver capture node (named after
// snapcast.stream_name); hardware sinks link generically to <sink>:playback_{FL,FR}.
// Docker-only: it shells pw-link/pw-dump with XDG_RUNTIME_DIR=/run/pipewire.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.js";
import { makeLog } from "./log.js";

const log = makeLog("pipewire");

export const SINK_NODE = "soloist-sink";
export const MONITOR_PORTS = ["monitor_FL", "monitor_FR"] as const;
export const PLAYBACK_PORTS = ["playback_FL", "playback_FR"] as const;
// Reserved node.name for the synthetic Snapcast entry in /api/pipewire-sinks;
// real PipeWire nodes never use it, so it maps unambiguously to audio.snapcast.
export const SNAPCAST_KEY = "snapcast";

// Runs a command and resolves its stdout; rejects on non-zero exit.
export type Runner = (cmd: string, args: string[]) => Promise<string>;

const pexec = promisify(execFile);
const defaultRun: Runner = async (cmd, args) => {
  const { stdout } = await pexec(cmd, args, {
    env: { ...process.env, XDG_RUNTIME_DIR: "/run/pipewire" },
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
};

export interface PwSink {
  name: string;
  description: string;
}

// Audio/Sink nodes from a `pw-dump` JSON array, minus the internal soloist-sink
// and any `exclude` names. The Snapserver capture node registers as an Audio/Sink
// named after stream_name, so callers pass it in `exclude` to avoid listing it as
// a hardware sink alongside the synthetic Snapcast toggle.
export function parseSinks(pwDumpJson: string, exclude: string[] = []): PwSink[] {
  let objs: unknown;
  try {
    objs = JSON.parse(pwDumpJson);
  } catch {
    return [];
  }
  if (!Array.isArray(objs)) return [];
  const skip = new Set([SINK_NODE, ...exclude]);
  const sinks: PwSink[] = [];
  for (const o of objs) {
    const props = (o as any)?.info?.props;
    if (!props || props["media.class"] !== "Audio/Sink") continue;
    const name = String(props["node.name"] ?? "").trim();
    if (!name || skip.has(name)) continue;
    // node.description is often the generic "Built-in Audio Stereo"; the ALSA card
    // name (or nick) distinguishes cards (e.g. "IQaudIODAC" vs "bcm2835 Headphones").
    const desc = props["alsa.card_name"] ?? props["node.nick"] ?? props["node.description"] ?? name;
    sinks.push({ name, description: String(desc) });
  }
  return sinks;
}

// /api/pipewire-sinks payload: the synthetic Snapcast toggle first, then real sinks.
export function pipewireSinksResponse(sinks: PwSink[]): PwSink[] {
  return [{ name: SNAPCAST_KEY, description: "Snapcast" }, ...sinks];
}

// PipeWire node names the monitor should currently be linked to, per config.
// Snapcast → the Snapserver capture node (stream_name); plus each hardware output.
export function desiredTargets(cfg: Config): string[] {
  const targets: string[] = [];
  if (cfg.audio.snapcast) targets.push(cfg.streamName);
  for (const name of cfg.audio.outputs) {
    const t = name.trim();
    if (t && t !== SNAPCAST_KEY && t !== SINK_NODE) targets.push(t);
  }
  return [...new Set(targets)];
}

// Node names currently linked from soloist-sink:monitor_*, parsed from `pw-link -o -l`.
// Output blocks are headed by an output port; `|-> node:port` lines under a
// soloist-sink:monitor header are the live fan-out links.
export function parseMonitorTargets(pwLinkOutput: string): string[] {
  const targets = new Set<string>();
  let underMonitor = false;
  for (const line of pwLinkOutput.split("\n")) {
    if (!/^\s/.test(line) && !line.includes("->")) {
      // A header line (an output port). Strip an optional leading numeric id.
      const header = line.replace(/^\s*\d+\s+/, "").trim();
      underMonitor = header.startsWith(`${SINK_NODE}:monitor`);
      continue;
    }
    if (!underMonitor) continue;
    const m = line.match(/->\s*(?:\d+\s+)?(\S+):\S+/);
    if (m) targets.add(m[1]);
  }
  return [...targets];
}

export interface ReconcileOptions {
  run?: Runner;
  retries?: number;
  intervalMs?: number;
}

export interface ReconcileResult {
  linked: string[];
  removed: string[];
  missing: string[];
}

// Bounded wait for a target node's playback input port to appear.
async function waitForNode(node: string, run: Runner, retries: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const inputs = await run("pw-link", ["-i"]);
      if (inputs.includes(`${node}:${PLAYBACK_PORTS[0]}`)) return true;
    } catch {
      // pw-link unavailable / transient — treat as "not yet" and retry
    }
    if (i < retries - 1) await sleep(intervalMs);
  }
  return false;
}

// Link (or, with remove, `pw-link -d` unlink) both channels soloist-sink:monitor
// -> node:playback. Failures are ignored: an existing/absent link exits non-zero.
async function linkPair(node: string, run: Runner, remove = false): Promise<void> {
  for (let i = 0; i < MONITOR_PORTS.length; i++) {
    const args = [`${SINK_NODE}:${MONITOR_PORTS[i]}`, `${node}:${PLAYBACK_PORTS[i]}`];
    await run("pw-link", remove ? ["-d", ...args] : args).catch(() => "");
  }
}

// ponytail: single-slot chain serializing reconciles. Boot and config-save both
// fire-and-forget reconcileOutputs, and boot can sit in the wait/retry window when
// a save lands — running them concurrently would race pw-link on the same graph.
let reconcileChain: Promise<unknown> = Promise.resolve();

// Reconcile the live fan-out to match config: link every enabled output (waiting
// for its node to appear), unlink deselected ones. A configured output whose node
// never appears is skipped and flagged (missing), not treated as an error.
export function reconcileOutputs(cfg: Config, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const task = reconcileChain.then(() => runReconcile(cfg, opts));
  reconcileChain = task.catch(() => {});
  return task;
}

async function runReconcile(cfg: Config, opts: ReconcileOptions): Promise<ReconcileResult> {
  const run = opts.run ?? defaultRun;
  const retries = opts.retries ?? 30;
  const intervalMs = opts.intervalMs ?? 1000;

  const desired = desiredTargets(cfg);
  let current: string[];
  try {
    current = parseMonitorTargets(await run("pw-link", ["-o", "-l"]));
  } catch (err) {
    // No reachable PipeWire graph (e.g. standalone, no pw-link): nothing to do.
    // In Docker the proxy only starts after wait-for-sink, so this means absent.
    log("pipewire graph unavailable; skipping reconcile: %s", (err as Error).message);
    return { linked: [], removed: [], missing: [] };
  }

  const result: ReconcileResult = { linked: [], removed: [], missing: [] };

  for (const node of desired) {
    if (await waitForNode(node, run, retries, intervalMs)) {
      await linkPair(node, run);
      result.linked.push(node);
    } else {
      result.missing.push(node);
      log("output node '%s' absent; skipped (flagged)", node);
    }
  }

  const wanted = new Set(desired);
  for (const node of current) {
    if (!wanted.has(node)) {
      await linkPair(node, run, true);
      result.removed.push(node);
    }
  }

  log("reconcile: linked=%o removed=%o missing=%o", result.linked, result.removed, result.missing);
  return result;
}

// Enumerate selectable Audio Outputs for the UI: the synthetic Snapcast toggle
// plus real Audio/Sink nodes (minus soloist-sink and the Snapserver capture node,
// which registers as an Audio/Sink named after stream_name).
export async function listPipewireSinks(cfg: Config): Promise<PwSink[]> {
  const dump = await defaultRun("pw-dump", []);
  return pipewireSinksResponse(parseSinks(dump, [cfg.streamName]));
}
