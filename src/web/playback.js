// Playback state + WS connection to the Proxy. Importable in Node for the selftest
// (fmtTime, readQueue); the WS/DOM wiring (connectWs) runs only in the browser.
//
// Auth: the page is same-origin, so the Web Session cookie rides the WS handshake
// automatically — checkAuth() falls through to sessionUser() and the socket lands
// in the control tier. No token in the URL.

import { entityToTrack, readTrack, readPlayback, nowMs as anchorNowMs, applyAnchor } from "./frame.js";

const $ = (id) => document.getElementById(id);

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// queue_changed.upcoming = [{uid, source, item:Entity}] — the up-next list.
export function readQueue(msg) {
  const list = msg && msg.upcoming;
  if (!Array.isArray(list)) return null;
  return list.map((e) => entityToTrack(e && e.item) || { title: "", artist: "", album: "", durationMs: 0, art: "" });
}

// Playback anchor + transport state, single shared instance. `connected` and
// `lastFrameAt` back the stale-UI guard: while disconnected, stop extrapolating
// position past the last frame we actually saw.
export const pb = {
  track: null, queue: [], playing: false,
  anchorMs: 0, anchorAt: 0, speed: 0,
  volume: null, shuffle: false, repeat: "off",
  connected: false, lastFrameAt: 0,
};

export function nowMs() {
  return anchorNowMs(pb);
}

const STALE_MS = 5000;
// True once the WS has been down long enough that the extrapolated position is no
// longer trustworthy — callers should freeze position and may dim the transport.
export function isStale() {
  return !pb.connected && pb.lastFrameAt > 0 && Date.now() - pb.lastFrameAt > STALE_MS;
}

function setWsPill(up) {
  const el = $("wsPill");
  if (!el) return;
  el.style.background = up ? "var(--ok-s)" : "var(--warn-s)";
  el.style.color = up ? "var(--ok)" : "var(--warn)";
  el.innerHTML = `<span class="dot" style="background:${up ? "var(--ok)" : "var(--warn)"}"></span>${up ? "Connected" : "Reconnecting…"}`;
}

// Apply one WS frame to `pb`. Returns which pieces changed, so a caller can drive
// UI/side-effects (lyrics lookup, queue render, ...) without this module reaching
// upward into app.js/overlay-panel.js.
export function onFrame(msg) {
  const t = readTrack(msg);
  if (t) pb.track = t;
  const q = readQueue(msg);
  if (q) pb.queue = q;
  const p = readPlayback(msg);
  applyAnchor(pb, p);
  pb.playing = typeof p.playing === "boolean" ? p.playing : pb.speed > 0;
  if (p.volume !== null) pb.volume = p.volume;
  if (msg.options) {
    if (typeof msg.options.shuffle === "boolean") pb.shuffle = msg.options.shuffle;
    if (typeof msg.options.repeat === "string") pb.repeat = msg.options.repeat;
  }
  pb.lastFrameAt = Date.now();
  return { track: t, queue: q };
}

let ws = null;
let backoffMs = 1000;
const BACKOFF_MAX_MS = 15000;

// Connect (and auto-reconnect with capped exponential backoff) to the Proxy WS.
// `onMessage(msg, delta)` fires after `pb` has been updated for each valid frame —
// `delta` is onFrame()'s return, so the caller knows what changed.
export function connectWs(onMessage) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/`);
  ws.onopen = () => { pb.connected = true; backoffMs = 1000; setWsPill(true); };
  ws.onclose = () => {
    pb.connected = false;
    setWsPill(false);
    setTimeout(() => connectWs(onMessage), backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const delta = onFrame(msg);
    onMessage?.(msg, delta);
  };
}

export function sendCommand(command, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "command", command, ...(extra || {}) }));
}
