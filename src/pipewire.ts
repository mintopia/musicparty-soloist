// Proxy-owned PipeWire fan-out (ADR-0011). Soloist plays into the `soloist-sink`
// null-sink; the Proxy links that sink's monitor ports to every enabled Audio
// Output on boot and on config save, and unlinks deselected ones. Snapcast is a
// synthetic output special-cased to the Snapserver capture node (named after
// snapcast.stream_name); hardware sinks link generically to <sink>:playback_{FL,FR}.
// Shells pw-link/pw-dump against the session's XDG_RUNTIME_DIR (Docker's ENV
// sets /run/pipewire; a native run inherits its own).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "./config.js";
import { makeLog } from "./log.js";

const log = makeLog("pipewire");

export const SINK_NODE = "soloist-sink";
export const MONITOR_PORTS = ["monitor_FL", "monitor_FR"] as const;
export const PLAYBACK_PORTS = ["playback_FL", "playback_FR"] as const;
// Reserved node.name for the synthetic Snapcast entry in /api/pipewire-sinks;
// real PipeWire nodes never use it, so it maps unambiguously to audio.snapcast.
export const SNAPCAST_KEY = "snapcast";

// Per-output playback delay (calibration knob, ADR-0013): a filter-chain "delay"
// node inserted between soloist-sink:monitor and a hardware sink. Its capture side
// registers as node "input.soloist-delay-<token>" (ports input_FL/FR) and its
// playback side as "output.soloist-delay-<token>" (ports output_FL/FR).
export const DELAY_PREFIX = "soloist-delay-";
export const DELAY_INPUT_PORTS = ["input_FL", "input_FR"] as const;
export const DELAY_OUTPUT_PORTS = ["output_FL", "output_FR"] as const;

// Runs a command and resolves its stdout; rejects on non-zero exit.
export type Runner = (cmd: string, args: string[]) => Promise<string>;

// PipeWire socket dir: inherit the session's XDG_RUNTIME_DIR (native run), else
// default to the Docker path the image's ENV sets. Docker already exports
// /run/pipewire, so inheriting is a no-op there; only the native case needs it.
const pwEnv = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/pipewire" };

const pexec = promisify(execFile);
const defaultRun: Runner = async (cmd, args) => {
  const { stdout } = await pexec(cmd, args, {
    env: pwEnv,
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

// Hardware outputs (never Snapcast) that are enabled and have a >0ms delay.
export function desiredDelays(cfg: Config): Record<string, number> {
  const delays: Record<string, number> = {};
  for (const name of cfg.audio.outputs) {
    const t = name.trim();
    if (!t || t === SNAPCAST_KEY || t === SINK_NODE) continue;
    const ms = cfg.audio.outputDelays?.[t] ?? 0;
    if (ms > 0) delays[t] = ms;
  }
  return delays;
}

function sanitizeToken(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "sink";
}

// node.name -> safe filter-chain token, collision-proofed (distinct names that
// sanitize the same get -2, -3, ... suffixes).
export function buildDelayTokens(delays: Record<string, number>): Map<string, string> {
  const owner = new Map<string, string>(); // token -> node
  const tokens = new Map<string, string>(); // node -> token
  for (const node of Object.keys(delays).sort()) {
    const base = sanitizeToken(node);
    let token = base;
    for (let i = 2; owner.has(token) && owner.get(token) !== node; i++) token = `${base}-${i}`;
    owner.set(token, node);
    tokens.set(node, token);
  }
  return tokens;
}

// A self-contained filter-chain conf (protocol-native + client-node so it can
// register as a client against the running daemon, per node one delay filter).
export function generateFilterChainConf(delays: Record<string, number>, tokens: Map<string, string>): string {
  const blocks = [...tokens.entries()].map(([node, token]) => {
    const seconds = (Math.min(5000, Math.max(0, delays[node])) / 1000).toFixed(3);
    return `  { name = libpipewire-module-filter-chain
    args = {
      node.name = "${DELAY_PREFIX}${token}"
      media.class = Audio/Filter
      audio.channels = 2
      audio.position = [ FL FR ]
      capture.props  = { node.autoconnect = false }
      playback.props = { node.autoconnect = false }
      filter.graph = {
        nodes = [
          { type = builtin label = delay name = dL config = { "max-delay" = 5.0 } control = { "Delay (s)" = ${seconds} } }
          { type = builtin label = delay name = dR config = { "max-delay" = 5.0 } control = { "Delay (s)" = ${seconds} } }
        ]
        inputs  = [ "dL:In" "dR:In" ]
        outputs = [ "dL:Out" "dR:Out" ]
      }
    }
  }`;
  });
  // spa-libs + the adapter module are what let the filter-chain node create its
  // stream ("no adapter factory found" without them). rt is deliberately omitted:
  // it hard-fails in the container (no dbus/RTKit) and the delay needs no RT sched.
  return `context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.*       = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
${blocks.join("\n")}
]
`;
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

// Spawns a long-lived child (the filter-chain delay process); resolves immediately,
// the caller keeps the handle to kill it later. Swappable for tests.
export type Spawner = (cmd: string, args: string[]) => ChildProcess;

const defaultSpawn: Spawner = (cmd, args) =>
  spawn(cmd, args, { env: pwEnv, stdio: "ignore" });

export interface ReconcileOptions {
  run?: Runner;
  retries?: number;
  intervalMs?: number;
  spawn?: Spawner;
}

export interface ReconcileResult {
  linked: string[];
  removed: string[];
  missing: string[];
}

// Bounded wait for a full "node:port" to appear on the input (destination) port list.
async function waitForPort(port: string, run: Runner, retries: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const inputs = await run("pw-link", ["-i"]);
      if (inputs.includes(port)) return true;
    } catch {
      // pw-link unavailable / transient — treat as "not yet" and retry
    }
    if (i < retries - 1) await sleep(intervalMs);
  }
  return false;
}

// Bounded wait for a target node's playback input port to appear.
async function waitForNode(node: string, run: Runner, retries: number, intervalMs: number): Promise<boolean> {
  return waitForPort(`${node}:${PLAYBACK_PORTS[0]}`, run, retries, intervalMs);
}

// Link (or, with remove, `pw-link -d` unlink) both channels src:srcPorts[i] -> dst:dstPorts[i].
// Failures are ignored: an existing/absent link exits non-zero.
async function linkPorts(
  srcNode: string,
  srcPorts: readonly string[],
  dstNode: string,
  dstPorts: readonly string[],
  run: Runner,
  remove = false,
): Promise<void> {
  for (let i = 0; i < srcPorts.length; i++) {
    const args = [`${srcNode}:${srcPorts[i]}`, `${dstNode}:${dstPorts[i]}`];
    await run("pw-link", remove ? ["-d", ...args] : args).catch(() => "");
  }
}

// soloist-sink:monitor -> node:playback (the direct, no-delay route).
async function linkPair(node: string, run: Runner, remove = false): Promise<void> {
  await linkPorts(SINK_NODE, MONITOR_PORTS, node, PLAYBACK_PORTS, run, remove);
}

// ponytail: single-slot chain serializing reconciles. Boot and config-save both
// fire-and-forget reconcileOutputs, and boot can sit in the wait/retry window when
// a save lands — running them concurrently would race pw-link on the same graph.
let reconcileChain: Promise<unknown> = Promise.resolve();

// The one filter-chain child hosting every delayed output's delay node, keyed by
// the delay map it was spawned for so an unchanged map is a no-op on reconcile.
let delayChild: ChildProcess | null = null;
let delayChildKey = "";

// Kill/respawn the single delay-filter child if the desired delay map changed;
// kill it outright (no respawn) once the map is empty. We own the child_process
// handle, so we kill it directly — the minimal image has no pkill.
async function ensureDelayChild(delays: Record<string, number>, tokens: Map<string, string>, opts: ReconcileOptions): Promise<void> {
  const key = Object.keys(delays)
    .sort()
    .map((n) => `${n}=${delays[n]}`)
    .join(",");
  if (key === delayChildKey) return;
  if (delayChild) {
    delayChild.kill();
    delayChild = null;
  }
  delayChildKey = "";
  if (!key) return;
  const conf = generateFilterChainConf(delays, tokens);
  const confPath = join(tmpdir(), "soloist-delay-chain.conf");
  writeFileSync(confPath, conf);
  const spawnFn = opts.spawn ?? defaultSpawn;
  const child = spawnFn("pipewire", ["-c", confPath]);
  child.on("error", (err) => log("delay filter-chain spawn failed: %s", (err as Error).message));
  delayChild = child;
  delayChildKey = key;
}

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
  const delays = desiredDelays(cfg);
  const tokens = buildDelayTokens(delays);
  let current: string[];
  try {
    current = parseMonitorTargets(await run("pw-link", ["-o", "-l"]));
  } catch (err) {
    // No reachable PipeWire graph (e.g. standalone, no pw-link): nothing to do.
    // In Docker the proxy only starts after wait-for-sink, so this means absent.
    log("pipewire graph unavailable; skipping reconcile: %s", (err as Error).message);
    return { linked: [], removed: [], missing: [] };
  }

  await ensureDelayChild(delays, tokens, opts);

  const result: ReconcileResult = { linked: [], removed: [], missing: [] };

  for (const node of desired) {
    const delayMs = delays[node];
    if (delayMs) {
      const inNode = `${DELAY_PREFIX}${tokens.get(node)}`;
      const ready =
        (await waitForPort(`input.${inNode}:${DELAY_INPUT_PORTS[0]}`, run, retries, intervalMs)) &&
        (await waitForNode(node, run, retries, intervalMs));
      if (ready) {
        await linkPorts(SINK_NODE, MONITOR_PORTS, `input.${inNode}`, DELAY_INPUT_PORTS, run);
        await linkPorts(`output.${inNode}`, DELAY_OUTPUT_PORTS, node, PLAYBACK_PORTS, run);
        result.linked.push(node);
      } else {
        result.missing.push(node);
        log("output node '%s' (or its delay filter) absent; skipped (flagged)", node);
      }
    } else if (await waitForNode(node, run, retries, intervalMs)) {
      await linkPair(node, run);
      result.linked.push(node);
    } else {
      result.missing.push(node);
      log("output node '%s' absent; skipped (flagged)", node);
    }
  }

  // The direct-link target for each desired output: the delay filter's input node
  // when delayed, else the sink itself — this is what actually appears in `current`.
  const wanted = new Set(
    desired.map((node) => (delays[node] ? `input.${DELAY_PREFIX}${tokens.get(node)}` : node)),
  );
  for (const node of current) {
    if (wanted.has(node)) continue;
    if (node.startsWith(`input.${DELAY_PREFIX}`)) {
      await linkPorts(SINK_NODE, MONITOR_PORTS, node, DELAY_INPUT_PORTS, run, true);
    } else {
      await linkPair(node, run, true);
    }
    result.removed.push(node);
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
