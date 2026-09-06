import { reactive, ref } from "vue";
import { readTrack, readPlayback, readQueue, applyAnchor, nowMs, type Track } from "../lib/wire";

interface PlaybackState {
  track: Track | null;
  queue: Track[];
  playing: boolean;
  anchorMs: number;
  anchorAt: number;
  speed: number;
  volume: number | null;
  shuffle: boolean;
  repeat: string;
  connected: boolean;
  lastFrameAt: number;
}

const state = reactive<PlaybackState>({
  track: null, queue: [], playing: false,
  anchorMs: 0, anchorAt: 0, speed: 0,
  volume: null, shuffle: false, repeat: "off",
  connected: false, lastFrameAt: 0,
});

// A 500ms tick drives interpolated position without re-anchoring on every read.
const positionMs = ref(0);

const STALE_MS = 5000;
function isStale(): boolean {
  return !state.connected && state.lastFrameAt > 0 && Date.now() - state.lastFrameAt > STALE_MS;
}

function onFrame(msg: any) {
  const t = readTrack(msg);
  if (t) state.track = t;
  const q = readQueue(msg);
  if (q) state.queue = q;
  const p = readPlayback(msg);
  applyAnchor(state, p);
  state.playing = typeof p.playing === "boolean" ? p.playing : state.speed > 0;
  if (p.volume !== null) state.volume = p.volume;
  if (msg.options) {
    if (typeof msg.options.shuffle === "boolean") state.shuffle = msg.options.shuffle;
    if (typeof msg.options.repeat === "string") state.repeat = msg.options.repeat;
  }
  state.lastFrameAt = Date.now();
}

let ws: WebSocket | null = null;
let backoffMs = 1000;
const BACKOFF_MAX_MS = 15000;
let started = false;

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/`);
  ws.onopen = () => { state.connected = true; backoffMs = 1000; };
  ws.onclose = () => {
    state.connected = false;
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  };
  ws.onerror = () => ws?.close();
  ws.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    onFrame(msg);
  };
}

// Idempotent: the shell calls start() once; extra callers just receive the shared state.
function start() {
  if (started) return;
  started = true;
  connect();
  setInterval(() => {
    positionMs.value = isStale() ? state.anchorMs : nowMs(state);
  }, 500);
}

export function sendCommand(command: string, extra?: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "command", command, ...(extra || {}) }));
}

export function usePlayback() {
  return { state, positionMs, isStale, start, sendCommand };
}
