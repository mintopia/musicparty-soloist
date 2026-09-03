// Landing Page controller. Pure view-model helpers (fmtTime, readTrack,
// readPlayback, readQueue, entityToTrack) are importable in Node for the selftest;
// the DOM + WS wiring boots only in the browser (guarded at the bottom).
//
// Auth: the page is same-origin, so the Web Session cookie rides the WS
// handshake automatically — checkAuth() falls through to sessionUser() and the
// socket lands in the control tier. No token in the URL.

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// A Soloist Entity's decorations -> flat track (Soloist WebSocket API): title =
// identity.name, artists = creators[].entity.identity.name, album =
// parent.entity.identity.name, art = visual_identity.cover[], duration =
// playback.duration_ms.
export function entityToTrack(item) {
  if (!item || typeof item !== "object") return null;
  const d = item.decorations || {};
  const title = d.identity?.name || "";
  const creators = Array.isArray(d.creators) ? d.creators : [];
  const artist = creators.map((c) => c?.entity?.decorations?.identity?.name).filter(Boolean).join(", ");
  const album = d.parent?.entity?.decorations?.identity?.name || "";
  const durationMs = Number(d.playback?.duration_ms) || 0;
  const art = pickCover(d.visual_identity?.cover);
  if (!title && !artist) return null;
  return { uri: item.uri || "", title, artist, album, durationMs, art };
}

// cover sizes are small|default|large|xlarge — prefer a mid/large one.
function pickCover(covers) {
  if (!Array.isArray(covers) || !covers.length) return "";
  const by = {};
  for (const c of covers) if (c && c.url) by[c.size] = c.url;
  return by.large || by.default || by.xlarge || by.small || covers[0].url || "";
}

// track_changed and playback_state both nest the current track under `item`.
export function readTrack(msg) {
  return msg && msg.item ? entityToTrack(msg.item) : null;
}

// The position anchor rides playback_state + position_sync as
// position = { position_ms sampled at server epoch timestamp_ms, advancing at speed }.
// status (idle|playing|paused|buffering) rides playback_state + playback_changed;
// volume rides playback_state + volume_changed.
export function readPlayback(msg) {
  const p = msg?.position;
  const positionMs = p && typeof p.position_ms === "number" ? p.position_ms : null;
  const timestampMs = p && typeof p.timestamp_ms === "number" ? p.timestamp_ms : null;
  const speed = p && typeof p.speed === "number" ? p.speed : null;
  const playing = typeof msg?.status === "string" ? msg.status === "playing" : undefined;
  const volume = typeof msg?.volume === "number" ? msg.volume : null;
  return { positionMs, timestampMs, speed, playing, volume };
}

// queue_changed.upcoming = [{uid, source, item:Entity}] — the up-next list.
export function readQueue(msg) {
  const list = msg && msg.upcoming;
  if (!Array.isArray(list)) return null;
  return list.map((e) => entityToTrack(e && e.item) || { title: "", artist: "", album: "", durationMs: 0, art: "" });
}

// --- browser-only below ---

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function api(path, opts) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthenticated"); }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const state = {
  cfg: null, // masked config (GET /api/config), the editor's working copy
  summary: null,
  webhooks: null,
  sinks: [],
  dirty: false,
  view: "now",
  ovTab: "layout",
  previewLyrics: { uri: null, lines: [], status: "idle" }, // status: idle|checking|available|none|notrack
  previewRender: null,
};

// ---- playback state fed by the WS ----
// Playback anchor: position_ms as of the server epoch anchorAt (timestamp_ms),
// advancing at `speed` (0 = paused). Interpolate against the server clock (Date.now),
// NOT frame-arrival time — a sync sampled seconds ago, or a stale snapshot replayed on
// reconnect, would otherwise read as "now", so lyrics drift and worsen as the anchor ages.
const pb = { track: null, queue: [], playing: false, anchorMs: 0, anchorAt: 0, speed: 0, volume: null, shuffle: false, repeat: "off" };

function nowMs() {
  return pb.anchorMs + pb.speed * (Date.now() - pb.anchorAt);
}

let ws = null;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/`);
  ws.onopen = () => setWsPill(true);
  ws.onclose = () => { setWsPill(false); setTimeout(connectWs, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    onFrame(msg);
  };
}

function sendCommand(command, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "command", command, ...(extra || {}) }));
}

function onFrame(msg) {
  const t = readTrack(msg);
  if (t) { pb.track = t; if (state.view === "overlay") ensurePreviewLyrics(); }
  const q = readQueue(msg);
  if (q) { pb.queue = q; renderQueue(); }
  const p = readPlayback(msg);
  if (p.positionMs !== null) {
    // Server-provided anchor: trust its sample time and speed verbatim.
    pb.anchorMs = p.positionMs;
    pb.anchorAt = p.timestampMs ?? Date.now();
    if (p.speed !== null) pb.speed = p.speed;
  } else if (typeof p.playing === "boolean") {
    // Status-only frame (e.g. playback_changed): re-anchor at the current position.
    pb.anchorMs = nowMs();
    pb.anchorAt = Date.now();
    pb.speed = p.playing ? 1 : 0;
  }
  pb.playing = typeof p.playing === "boolean" ? p.playing : pb.speed > 0;
  if (p.volume !== null) pb.volume = p.volume;
  if (msg.options) {
    if (typeof msg.options.shuffle === "boolean") pb.shuffle = msg.options.shuffle;
    if (typeof msg.options.repeat === "string") pb.repeat = msg.options.repeat;
  }
  renderNowPlaying();
}

function setWsPill(up) {
  const el = $("wsPill");
  el.style.background = up ? "var(--ok-s)" : "var(--warn-s)";
  el.style.color = up ? "var(--ok)" : "var(--warn)";
  el.innerHTML = `<span class="dot" style="background:${up ? "var(--ok)" : "var(--warn)"}"></span>${up ? "Connected" : "Reconnecting…"}`;
}

// Set clip's text, and if it overflows, ping-pong scroll it (pausing at each end).
// Idempotent per element+text so the 500ms render tick doesn't restart the scroll.
function setScrollingText(clip, text) {
  const t = text || "";
  if (clip.dataset.mqText === t && clip.firstElementChild) return;
  clip.dataset.mqText = t;
  clip.style.overflow = "hidden";
  clip.style.whiteSpace = "nowrap";
  let span = clip.firstElementChild;
  if (!span || !span.classList.contains("mq")) {
    clip.textContent = "";
    span = document.createElement("span");
    span.className = "mq";
    span.style.cssText = "display:inline-block;will-change:transform";
    clip.appendChild(span);
  }
  span.textContent = t;
  span.getAnimations().forEach((a) => a.cancel());
  span.style.transform = "translateX(0)";
  requestAnimationFrame(() => {
    const overflow = span.scrollWidth - clip.clientWidth;
    if (overflow <= 1) return;
    span.animate([
      { transform: "translateX(0)" },
      { transform: "translateX(0)", offset: 0.12 },
      { transform: `translateX(${-overflow}px)`, offset: 0.5 },
      { transform: `translateX(${-overflow}px)`, offset: 0.62 },
      { transform: "translateX(0)" },
    ], { duration: Math.max(6000, overflow * 90), iterations: Infinity, easing: "ease-in-out" });
  });
}

// ---- now playing (mini player is always present; the hero card only on the Now view) ----
function renderNowPlaying() {
  const t = pb.track;
  // mini player (top bar) — always
  const mp = $("miniPlayer");
  if (mp) {
    mp.classList.toggle("hidden", !t);
    if (t) {
      setScrollingText($("mpTitle"), t.title || "Untitled");
      $("mpArtist").textContent = t.artist || "—";
      $("mpArt").style.backgroundImage = t.art ? `url("${encodeURI(t.art)}")` : "";
      $("mpPlayIcon").innerHTML = pb.playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
      const dur = t.durationMs || 0;
      $("mpProg").style.width = (dur ? Math.min(100, Math.max(0, (Math.min(nowMs(), dur) / dur) * 100)) : 0) + "%";
    }
  }
  if (!$("npTitle")) return; // Now view not mounted

  $("npStatus").textContent = t ? (pb.playing ? "Now playing" : "Paused") : "Idle";
  $("npDot").style.background = t && pb.playing ? "#34d399" : "#6b6b72";
  $("npDot").style.boxShadow = t && pb.playing ? "0 0 8px #34d399" : "none";
  setScrollingText($("npTitle"), t ? t.title || "Untitled" : "Nothing playing");
  $("npArtist").textContent = t ? [t.artist, t.album].filter(Boolean).join(" — ") || "—" : "—";
  $("npArt").style.backgroundImage = t && t.art ? `url("${encodeURI(t.art)}")` : "";
  $("playIcon").innerHTML = pb.playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  const chips = $("npChips");
  chips.innerHTML = "";
  if (t) for (const c of [t.album && "◆ " + t.album].filter(Boolean)) {
    const s = document.createElement("span"); s.className = "hchip"; s.textContent = c; chips.appendChild(s);
  }
  const dur = t ? t.durationMs : 0;
  const pos = Math.min(nowMs(), dur || Infinity);
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  $("npFill").style.inset = `0 ${100 - pct}% 0 0`;
  $("npHandle").style.left = `${pct}%`;
  $("npPos").textContent = fmtTime(pos);
  $("npDur").textContent = fmtTime(dur);
  if (pb.volume !== null) {
    const v = Math.max(0, Math.min(100, pb.volume));
    $("volFill").style.inset = `0 ${100 - v}% 0 0`;
    $("volHandle").style.left = `${v}%`;
  }
  $("btnShuffle").classList.toggle("act", pb.shuffle);
  $("btnRepeat").classList.toggle("act", pb.repeat !== "off");
  $("btnRepeat").title = pb.repeat === "track" ? "Repeat: track" : pb.repeat === "context" ? "Repeat: context" : "Repeat";
}

function renderQueue() {
  const list = $("qList");
  if (!list) return;
  const q = pb.queue;
  $("qCount").textContent = String(q.length);
  list.querySelectorAll(".qrowd").forEach((n) => n.remove());
  $("qEmpty").style.display = q.length ? "none" : "block";
  q.forEach((t) => {
    const row = document.createElement("div");
    row.className = "row qrowd";
    row.style.cssText = "gap:12px;padding:7px 10px";
    row.innerHTML =
      `<div style="width:38px;height:38px;border-radius:8px;flex:0 0 auto;background:${t.art ? `url('${encodeURI(t.art)}') center/cover` : "linear-gradient(135deg,#5eead4,#22d3ee)"}"></div>` +
      `<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div><div style="font-size:12px;color:rgba(255,255,255,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist)}</div></div>` +
      `<span style="font-size:11.5px;color:rgba(255,255,255,.4);font-variant-numeric:tabular-nums">${t.durationMs ? fmtTime(t.durationMs) : ""}</span>`;
    list.appendChild(row);
  });
}

// ---- top nav / views ----
const VIEWS = [
  { key: "now", label: "Now Playing" },
  { key: "audio", label: "Audio" },
  { key: "webhooks", label: "Webhooks" },
  { key: "overlay", label: "Lyrics" },
  { key: "settings", label: "Settings" },
];

function renderNav() {
  const nav = $("nav");
  nav.innerHTML = "";
  for (const v of VIEWS) {
    const b = document.createElement("button");
    b.className = "tab" + (v.key === state.view ? " act" : "");
    b.textContent = v.label;
    b.onclick = () => setView(v.key);
    nav.appendChild(b);
  }
}

function setView(v) {
  state.view = v;
  renderNav();
  renderView();
}

function renderView() {
  const view = $("view");
  view.innerHTML = "";
  if (state.view === "now") buildNow(view);
  else if (state.view === "audio") buildAudio(view);
  else if (state.view === "webhooks") buildWebhooks(view);
  else if (state.view === "overlay") buildOverlay(view);
  else if (state.view === "settings") buildSettings(view);
}

// ---- Now Playing view ----
function buildNow(view) {
  view.insertAdjacentHTML("beforeend", `
  <div style="display:flex;flex-direction:column;gap:18px;max-width:720px;margin:0 auto">
    <div style="position:relative;border-radius:20px;overflow:hidden;
        background:linear-gradient(135deg,#191a2b 0%,#241a36 55%,#2c1830 100%);
        border:1px solid rgba(255,255,255,.10);box-shadow:0 22px 54px rgba(26,18,56,.30)">
      <div style="position:absolute;width:440px;height:440px;left:-130px;top:-210px;border-radius:50%;background:radial-gradient(circle,rgba(20,184,166,.42),transparent 64%);pointer-events:none"></div>
      <div style="position:absolute;width:440px;height:440px;right:-150px;bottom:-230px;border-radius:50%;background:radial-gradient(circle,rgba(6,182,212,.30),transparent 64%);pointer-events:none"></div>
      <div style="position:relative;padding:26px 28px">
        <div class="row" style="gap:24px;align-items:center">
          <div id="npArt" style="width:120px;height:120px;border-radius:16px;background:linear-gradient(135deg,#5eead4,#22d3ee 55%,#14b8a6);background-size:cover;background-position:center;flex:0 0 auto;box-shadow:0 16px 36px rgba(0,0,0,.45)"></div>
          <div style="flex:1;min-width:0">
            <div class="row" style="gap:8px"><span id="npDot" class="dot" style="background:#6b6b72"></span><span id="npStatus" style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.6)">Idle</span></div>
            <div id="npTitle" style="font-family:var(--disp);font-size:30px;font-weight:700;letter-spacing:-.02em;color:#fff;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Nothing playing</div>
            <div id="npArtist" style="color:rgba(255,255,255,.72);font-size:15px;margin-top:3px">—</div>
            <div id="npChips" class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap"></div>
          </div>
        </div>
        <div style="margin-top:24px">
          <div id="npBar" style="height:5px;border-radius:4px;background:rgba(255,255,255,.16);position:relative;cursor:pointer">
            <div id="npFill" style="position:absolute;inset:0 100% 0 0;background:linear-gradient(90deg,#14b8a6,#2dd4bf);border-radius:4px"></div>
            <div id="npHandle" style="position:absolute;left:0;top:-4px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.4)"></div>
          </div>
          <div class="row" style="justify-content:space-between;margin-top:9px"><span id="npPos" style="font-size:12px;color:rgba(255,255,255,.55)">0:00</span><span id="npDur" style="font-size:12px;color:rgba(255,255,255,.55)">0:00</span></div>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:18px">
          <div class="row" style="gap:12px">
            <button id="btnShuffle" class="hbtn" title="Shuffle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6M4 4l5 5"/></svg></button>
            <button id="btnPrev" class="hbtn" title="Previous"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6L9 12l11 6z"/></svg></button>
            <button id="btnPlay" class="hplay" title="Play/Pause"><svg id="playIcon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
            <button id="btnNext" class="hbtn" title="Next"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l11 6L4 18z"/></svg></button>
            <button id="btnRepeat" class="hbtn" title="Repeat"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></button>
          </div>
          <div class="row" style="gap:11px">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
            <div id="volBar" style="width:118px;height:6px;border-radius:4px;background:rgba(255,255,255,.16);position:relative;cursor:pointer">
              <div id="volFill" style="position:absolute;inset:0 40% 0 0;background:linear-gradient(90deg,#14b8a6,#06b6d4);border-radius:4px"></div>
              <div id="volHandle" style="position:absolute;left:60%;top:-3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div style="border-radius:20px;overflow:hidden;position:relative;background:linear-gradient(180deg,#1c1d2e,#241a33);border:1px solid rgba(255,255,255,.10);box-shadow:0 22px 54px rgba(26,18,56,.26);display:flex;flex-direction:column">
      <div class="row" style="justify-content:space-between;padding:18px 20px 10px"><div class="row" style="gap:9px"><span style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.6)">Up next</span><span id="qCount" style="font-size:11px;font-weight:700;color:#0b3b36;background:#5eead4;border-radius:20px;padding:2px 9px">0</span></div></div>
      <div id="qList" style="flex:1;overflow:auto;padding:0 10px 12px;display:flex;flex-direction:column;gap:1px;max-height:520px">
        <div id="qEmpty" style="padding:16px 12px;font-size:13px;color:rgba(255,255,255,.4)">Queue is empty.</div>
      </div>
    </div>
  </div>`);
  $("btnPlay").onclick = () => sendCommand(pb.playing ? "pause" : "play");
  $("btnNext").onclick = () => sendCommand("skip_next");
  $("btnPrev").onclick = () => sendCommand("skip_prev");
  $("btnShuffle").onclick = () => sendCommand("set_shuffle", { enabled: !pb.shuffle });
  $("btnRepeat").onclick = cycleRepeat;
  $("npBar").onclick = (e) => {
    const dur = pb.track ? pb.track.durationMs : 0;
    if (!dur) return;
    const r = $("npBar").getBoundingClientRect();
    sendCommand("seek", { position_ms: Math.round(dur * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))) });
  };
  $("volBar").onclick = (e) => {
    const r = $("volBar").getBoundingClientRect();
    sendCommand("set_volume", { volume: Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) });
  };
  renderNowPlaying();
  renderQueue();
}

function cycleRepeat() {
  const next = pb.repeat === "off" ? "context" : pb.repeat === "context" ? "track" : "off";
  if (next === "context") sendCommand("set_repeat_context", { enabled: true });
  else if (next === "track") sendCommand("set_repeat_track", { enabled: true });
  else { sendCommand("set_repeat_context", { enabled: false }); sendCommand("set_repeat_track", { enabled: false }); }
}

// ---- shared form controls ----
function grid(cols) {
  const g = document.createElement("div");
  g.className = "fgrid";
  g.style.cssText = `display:grid;grid-template-columns:${cols};gap:16px 20px`;
  return g;
}

// Single-column form pages (Audio/Webhooks/Settings) share one centered column so
// the content edge never lurches tab-to-tab and fields don't stretch to full width.
function formCol() {
  const d = document.createElement("div");
  d.className = "fcol";
  return d;
}

function sectionCard(title, subtitle) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:22px;margin-bottom:18px";
  if (title) {
    const h = document.createElement("div");
    h.style.cssText = "margin-bottom:16px";
    h.innerHTML = `<div style="font-family:var(--disp);font-size:16px;font-weight:700">${esc(title)}</div>` +
      (subtitle ? `<div style="font-size:12.5px;color:var(--dim);margin-top:2px">${esc(subtitle)}</div>` : "");
    card.appendChild(h);
  }
  return card;
}

function field(label, value, onInput, opts = {}) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const inp = document.createElement("input");
  inp.className = "field" + (opts.ro ? " ro" : "");
  inp.value = value ?? "";
  if (opts.ro) inp.readOnly = true;
  if (opts.type) inp.type = opts.type;
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (!opts.ro && onInput) inp.oninput = () => onInput(inp.value);
  w.appendChild(inp);
  return w;
}

// Full-width setting row: title + description on the left, switch on the right,
// vertically centred, with a top divider. For standalone toggles (not grid cells).
function settingRow(label, desc, on, onToggle) {
  const w = document.createElement("div");
  w.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;padding-top:18px;border-top:1px solid var(--line)";
  w.innerHTML = `<div style="min-width:0"><div style="font-size:14px;font-weight:600">${esc(label)}</div>` +
    (desc ? `<div style="font-size:12.5px;color:var(--dim);margin-top:2px">${esc(desc)}</div>` : "") + `</div>`;
  const sw = document.createElement("div");
  sw.className = "sw " + (on ? "on" : "off");
  sw.innerHTML = "<i></i>";
  sw.style.flex = "0 0 auto";
  sw.onclick = onToggle;
  w.appendChild(sw);
  return w;
}

function captureSecrets() {
  state.secretSet = {};
  for (const [s, k] of [["soloist", "apiKey"], ["webhooks", "secret"], ["web", "password"]]) {
    state.secretSet[`${s}.${k}`] = state.cfg[s][k] === true;
  }
}

function secretRow(label, section, key) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const isSet = () => state.secretSet[`${section}.${key}`];
  const box = document.createElement("div");
  box.className = "field row";
  box.style.justifyContent = "space-between";
  const render = () => {
    const current = state.cfg[section][key];
    box.innerHTML = "";
    if (typeof current === "string") {
      const inp = document.createElement("input");
      inp.className = "field"; inp.type = "password"; inp.placeholder = "New value"; inp.value = current;
      inp.style.cssText = "border:none;background:transparent;padding:0;box-shadow:none";
      inp.oninput = () => { state.cfg[section][key] = inp.value; markDirty(); };
      const cancel = document.createElement("a");
      cancel.href = "#"; cancel.style.cssText = "font-size:12px;white-space:nowrap;margin-left:10px";
      cancel.textContent = "Cancel";
      cancel.onclick = (e) => { e.preventDefault(); state.cfg[section][key] = isSet(); render(); };
      box.append(inp, cancel);
    } else {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.style.cssText = isSet() ? "background:var(--ind-s);color:var(--ind)" : "background:var(--warn-s);color:var(--warn)";
      pill.textContent = isSet() ? "Set" : "Not set";
      const replace = document.createElement("a");
      replace.href = "#"; replace.style.cssText = "font-size:12px;margin-left:auto";
      replace.textContent = "Replace";
      replace.onclick = (e) => { e.preventDefault(); state.cfg[section][key] = ""; markDirty(); render(); };
      box.append(pill, replace);
    }
  };
  w.appendChild(box);
  render();
  return w;
}

// ---- Audio view ----
const ICON_SNAP = '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 5v14"/>';
const ICON_HW = '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>';

function buildAudio(view) {
  const c = state.cfg;
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:22px";
  const head = document.createElement("div");
  head.className = "row"; head.style.cssText = "justify-content:space-between;margin-bottom:18px";
  head.innerHTML = '<div style="font-family:var(--disp);font-size:16px;font-weight:700">Audio outputs</div>';
  const refresh = document.createElement("button"); refresh.className = "btn"; refresh.textContent = "Refresh sinks";
  refresh.onclick = async () => { await refreshSinks(); renderView(); };
  head.appendChild(refresh);
  card.appendChild(head);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:10px";
  const selected = new Set(c.audio.outputs);
  for (const sink of state.sinks) {
    const isSnap = sink.name === "snapcast";
    const on = isSnap ? c.audio.snapcast : selected.has(sink.name);
    const box = document.createElement("div");
    box.style.cssText = `border:1px solid ${on ? "var(--ind)" : "var(--line)"};border-radius:12px;background:${on ? "var(--ind-s)" : "var(--sub)"};overflow:hidden`;
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:14px;padding:12px 14px";
    const tile = `<div style="width:38px;height:38px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:${on ? "var(--ind)" : "#ececE7"};color:${on ? "#fff" : "var(--faint)"}"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${isSnap ? ICON_SNAP : ICON_HW}</svg></div>`;
    header.innerHTML = tile +
      `<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600${on ? "" : ";color:var(--dim)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sink.description)}</div><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin-top:2px">${isSnap ? "Snapcast stream" : "Hardware sink"}</div></div>`;
    const sw = document.createElement("div"); sw.className = "sw " + (on ? "on" : "off"); sw.innerHTML = "<i></i>"; sw.style.flex = "0 0 auto";
    sw.onclick = () => toggleOutput(sink.name, isSnap);
    header.appendChild(sw);
    box.appendChild(header);

    // Snapcast's stream-name field lives inside its box, revealed when enabled.
    if (isSnap && on) {
      const sub = document.createElement("div");
      sub.style.cssText = "padding:12px 14px;border-top:1px solid rgba(13,148,136,.22)";
      const sf = field("Stream name", c.streamName, (v) => { c.streamName = v; markDirty(); });
      sf.querySelector("input").style.maxWidth = "360px";
      sub.appendChild(sf);
      box.appendChild(sub);
    }
    list.appendChild(box);
  }
  if (!state.sinks.length) list.innerHTML = '<div style="font-size:13px;color:var(--faint);padding:20px 0;text-align:center">No PipeWire sinks reported. Is the audio path up?</div>';
  card.appendChild(list);
  const col = formCol(); col.appendChild(card); view.appendChild(col);
}

function toggleOutput(name, isSnap) {
  if (isSnap) state.cfg.audio.snapcast = !state.cfg.audio.snapcast;
  else {
    const outs = state.cfg.audio.outputs;
    const i = outs.indexOf(name);
    if (i >= 0) outs.splice(i, 1); else outs.push(name);
  }
  markDirty();
  renderView();
}

// ---- Webhooks view ----
function buildWebhooks(view) {
  const c = state.cfg;
  const col = formCol();
  const card = sectionCard("Webhooks");
  const topRow = document.createElement("div");
  topRow.style.cssText = "display:flex;gap:16px;align-items:flex-start;margin-bottom:16px";
  const urlF = field("Default URL", c.webhooks.defaultUrl, (v) => { c.webhooks.defaultUrl = v; markDirty(); }, { placeholder: "https://…" });
  urlF.style.flex = "1";
  const delayF = field("Delay (ms)", c.webhooks.delayMs, (v) => { c.webhooks.delayMs = Number(v) || 0; markDirty(); }, { type: "number" });
  delayF.style.cssText = "flex:0 0 auto;width:120px";
  topRow.append(urlF, delayF);
  card.appendChild(topRow);
  const secretF = secretRow("Shared secret", "webhooks", "secret");
  secretF.style.maxWidth = "340px";
  card.appendChild(secretF);
  const label = document.createElement("div");
  label.style.cssText = "margin:22px 0 10px";
  label.innerHTML = '<span class="lbl" style="color:var(--faint)">Per-event overrides</span>';
  card.appendChild(label);
  card.appendChild(urlMapEditor(c.webhooks.urls));
  col.appendChild(card);

  // delivery stats
  const wh = state.webhooks;
  const stats = sectionCard("Delivery");
  const entries = [];
  if (wh.config.defaultUrl) entries.push(["default", wh.config.defaultUrl]);
  for (const [k, v] of Object.entries(wh.config.urls || {})) entries.push([k, v]);
  if (!entries.length) stats.insertAdjacentHTML("beforeend", '<div style="font-size:13px;color:var(--faint)">No webhooks configured.</div>');
  entries.forEach(([name, url], i) => {
    const s = wh.stats[url];
    let pill = '<span class="pill" style="background:var(--sub);color:var(--dim)">no deliveries</span>';
    if (s) {
      const bad = s.fail > 0 && (s.lastStatus === null || s.lastStatus >= 400);
      const lbl = `${s.lastStatus ?? "err"} · ${s.ok}✓${s.fail ? " " + s.fail + "✗" : ""}`;
      pill = `<span class="pill" style="background:${bad ? "var(--bad-s)" : "var(--ok-s)"};color:${bad ? "var(--bad)" : "var(--ok)"}">${esc(lbl)}</span>`;
    }
    if (i > 0) { const hr = document.createElement("div"); hr.style.cssText = "height:1px;background:var(--line);margin:12px 0"; stats.appendChild(hr); }
    const row = document.createElement("div");
    row.className = "row"; row.style.justifyContent = "space-between";
    row.innerHTML = `<div style="min-width:0"><div style="font-size:14px;font-weight:600">${esc(name)}</div><div style="font-size:12px;color:var(--faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px">${esc(url)}</div></div>${pill}`;
    stats.appendChild(row);
  });
  col.appendChild(stats);
  view.appendChild(col);
}

// Soloist state events that fire webhooks (proxy.ts STATE_EVENTS), ordered by usefulness.
const WEBHOOK_EVENTS = ["track_changed", "playback_changed", "volume_changed", "queue_changed", "options_changed", "context_changed", "device_changed", "playback_state", "auth_state", "position_sync"];

function urlMapEditor(urls) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;max-width:700px";
  const draw = () => {
    wrap.innerHTML = "";
    for (const key of Object.keys(urls)) {
      const row = document.createElement("div");
      row.className = "row"; row.style.gap = "10px";
      const k = document.createElement("select");
      k.className = "field"; k.style.cssText = "max-width:210px;flex:0 0 auto";
      const opts = WEBHOOK_EVENTS.includes(key) ? WEBHOOK_EVENTS : [key, ...WEBHOOK_EVENTS];
      for (const ev of opts) { const o = document.createElement("option"); o.value = ev; o.textContent = ev; if (ev === key) o.selected = true; k.appendChild(o); }
      k.onchange = () => {
        const nv = k.value;
        if (nv === key || urls[nv] !== undefined) { k.value = key; return; } // no-op / already mapped
        urls[nv] = urls[key]; delete urls[key]; markDirty(); draw();
      };
      const v = document.createElement("input");
      v.className = "field"; v.style.flex = "1"; v.value = urls[key]; v.placeholder = "https://…";
      v.oninput = () => { urls[key] = v.value; markDirty(); };
      const del = document.createElement("button");
      del.className = "btn"; del.textContent = "×"; del.title = "Remove";
      del.onclick = () => { delete urls[key]; markDirty(); draw(); };
      row.append(k, v, del);
      wrap.appendChild(row);
    }
    const add = document.createElement("button");
    add.className = "btn"; add.textContent = "+ Add event override";
    add.onclick = () => { const next = WEBHOOK_EVENTS.find((e) => urls[e] === undefined); if (!next) return; urls[next] = ""; markDirty(); draw(); };
    wrap.appendChild(add);
  };
  draw();
  return wrap;
}

// ---- Settings view (Soloist + Web access + managed) ----
function buildSettings(view) {
  const c = state.cfg;
  const col = formCol();
  const soloist = sectionCard("Soloist");
  const g = grid("1fr 1fr");
  g.append(
    field("Device name", c.soloist.deviceName, (v) => { c.soloist.deviceName = v; markDirty(); }),
    field("Soloist WS", c.soloistWs, (v) => { c.soloistWs = v; markDirty(); }),
    secretRow("Spotify API key", "soloist", "apiKey"),
  );
  soloist.appendChild(g);
  soloist.appendChild(settingRow(
    "Autoplay on login",
    "Start playback automatically once Soloist signs in.",
    c.autoplay,
    () => { c.autoplay = !c.autoplay; markDirty(); renderView(); },
  ));
  col.appendChild(soloist);

  const web = sectionCard("Web access");
  const wg = grid("1fr 1fr");
  wg.append(
    field("Username", c.web.username, (v) => { c.web.username = v; markDirty(); }),
    secretRow("Password", "web", "password"),
  );
  web.appendChild(wg);
  col.appendChild(web);
  view.appendChild(col);
}

// ---- Overlay builder view ----
const OV_FONTS = [
  ["System", "system-ui, sans-serif"],
  ["Inter", "'Inter', sans-serif"],
  ["Roboto", "'Roboto', sans-serif"],
  ["Montserrat", "'Montserrat', sans-serif"],
  ["Bebas Neue", "'Bebas Neue', sans-serif"],
  ["Mono", "ui-monospace, monospace"],
];
const OV_EASING = [
  ["Settle", "cubic-bezier(.16,1,.3,1)"],
  ["Ease", "ease"],
  ["Ease out", "ease-out"],
  ["Ease in-out", "ease-in-out"],
  ["Linear", "linear"],
  ["Overshoot", "cubic-bezier(.34,1.56,.64,1)"],
];
const OV_MOTION = [["Slide + fade", "slide"], ["Crossfade", "crossfade"], ["Pop", "pop"], ["Instant", "instant"]];
const OV_EFFECTS = ["none", "glow", "shimmer", "rainbow", "sparkles", "wipe", "neon", "glitch", "pulse"];
const OV_LINES = ["1", "3", "5"];
const ALIGN_OPTS = [
  { value: "left", title: "Left", icon: '<path d="M4 6h16M4 12h10M4 18h13"/>' },
  { value: "center", title: "Center", icon: '<path d="M4 6h16M7 12h10M6 18h12"/>' },
  { value: "right", title: "Right", icon: '<path d="M4 6h16M10 12h10M7 18h13"/>' },
];
const anchorIcon = (y) => `<rect x="3" y="3" width="18" height="18" rx="2.5"/><rect x="7" y="${y}" width="10" height="3" rx="1.5" fill="currentColor" stroke="none"/>`;
const ANCHOR_OPTS = [
  { value: "top", title: "Top", icon: anchorIcon(6) },
  { value: "center", title: "Center", icon: anchorIcon(10.5) },
  { value: "bottom", title: "Bottom", icon: anchorIcon(15) },
];

const PREVIEW_LINES = [
  { time: 0, text: "So close, no matter how far" },
  { time: 2, text: "Couldn't be much more from the heart" },
  { time: 4, text: "Forever trusting who we are" },
  { time: 6, text: "And nothing else matters" },
  { time: 8, text: "Never opened myself this way" },
];
const PREVIEW_IDX = 2;

let overlayEngine = null;
async function loadOverlayEngine() {
  if (!overlayEngine) overlayEngine = await import("/overlay.js");
  return overlayEngine;
}

function ovSelect(label, val, pairs, onChange) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const s = document.createElement("select");
  s.className = "field";
  for (const opt of pairs) {
    const [text, value] = Array.isArray(opt) ? opt : [opt, opt];
    const op = document.createElement("option");
    op.value = value; op.textContent = text; if (value === String(val)) op.selected = true;
    s.appendChild(op);
  }
  s.onchange = () => { onChange(s.value); markDirty(); refreshPreview(); };
  w.appendChild(s);
  return w;
}

function ovRange(label, val, min, max, step, onChange, fmt = (v) => v) {
  const w = document.createElement("div");
  const val0 = Number(val);
  w.innerHTML = `<label class="flabel">${esc(label)}: <span class="ovval" style="color:var(--ind)">${esc(fmt(val0))}</span></label>`;
  const inp = document.createElement("input");
  inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = val0;
  inp.style.cssText = "width:100%;accent-color:var(--ind)";
  inp.oninput = () => { const n = Number(inp.value); w.querySelector(".ovval").textContent = fmt(n); onChange(n); markDirty(); refreshPreview(); };
  w.appendChild(inp);
  return w;
}

function ovNum(label, val, onChange) {
  return field(label, val, (v) => { onChange(Number(v) || 0); markDirty(); refreshPreview(); }, { type: "number" });
}

export function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { h = max === r ? (g - b) / d % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

// Colour picker: HSL sliders (tracks tinted to preview the value) + a swatch that
// opens the native picker for direct selection. Value is emitted as hex.
function ovColour(label, val, onChange) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  let [h, s, l] = hexToHsl(val || "#ffffff");

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:12px;align-items:center";
  const swatch = document.createElement("button");
  swatch.type = "button"; swatch.title = "Pick colour";
  swatch.style.cssText = "position:relative;width:42px;height:42px;flex:0 0 auto;border-radius:10px;border:1px solid var(--line2);cursor:pointer;padding:0";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.style.cssText = "position:absolute;inset:0;opacity:0;cursor:pointer";
  swatch.appendChild(picker);

  const sliders = document.createElement("div");
  sliders.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:7px";
  const mk = (max) => { const i = document.createElement("input"); i.type = "range"; i.className = "hsl"; i.min = "0"; i.max = String(max); i.step = "1"; return i; };
  const hI = mk(360), sI = mk(100), lI = mk(100);
  sliders.append(hI, sI, lI);
  row.append(swatch, sliders);
  w.appendChild(row);

  // Repaint tracks + swatch for a hex. Slider edits round-trip through integer HSL
  // (a slight, expected quantisation); a native-picker hex is stored verbatim.
  const paint = (hex) => {
    hI.value = h; sI.value = s; lI.value = l;
    swatch.style.background = hex; picker.value = hex;
    hI.style.background = "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)";
    sI.style.background = `linear-gradient(to right,hsl(${h},0%,${l}%),hsl(${h},100%,${l}%))`;
    lI.style.background = `linear-gradient(to right,hsl(${h},${s}%,0%),hsl(${h},${s}%,50%),hsl(${h},${s}%,100%))`;
  };
  const commit = (hex) => { onChange(hex); markDirty(); refreshPreview(); };
  const fromSliders = () => { const hex = hslToHex(h, s, l); paint(hex); commit(hex); };
  hI.oninput = () => { h = Number(hI.value); fromSliders(); };
  sI.oninput = () => { s = Number(sI.value); fromSliders(); };
  lI.oninput = () => { l = Number(lI.value); fromSliders(); };
  picker.oninput = () => { [h, s, l] = hexToHsl(picker.value); paint(picker.value); commit(picker.value); };
  paint(hslToHex(h, s, l));
  return w;
}

// Segmented icon group (alignment, anchor) — settings whose choices read as glyphs.
function ovIconGroup(label, val, options, setter) {
  const w = document.createElement("div");
  w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
  const seg = document.createElement("div");
  seg.style.cssText = "display:flex;background:var(--sub);border:1px solid var(--line2);border-radius:10px;padding:3px;gap:2px";
  for (const opt of options) {
    const on = String(val) === opt.value;
    const b = document.createElement("button");
    b.type = "button"; b.title = opt.title;
    b.style.cssText = "flex:1;display:flex;align-items:center;justify-content:center;padding:8px;border:none;border-radius:7px;cursor:pointer;" +
      (on ? "background:var(--card);color:var(--ind);box-shadow:var(--sh)" : "background:transparent;color:var(--dim)");
    b.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${opt.icon}</svg>`;
    b.onclick = () => { setter(opt.value); markDirty(); renderView(); };
    seg.appendChild(b);
  }
  w.appendChild(seg);
  return w;
}

function effectGallery() {
  const o = state.cfg.overlay;
  const wrap = document.createElement("div");
  wrap.innerHTML = '<label class="flabel">Effect (current line)</label>';
  const g = document.createElement("div");
  g.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:8px";
  for (const eff of OV_EFFECTS) {
    const on = o.effect === eff;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.style.cssText = `padding:0;border:1px solid ${on ? "var(--ind)" : "var(--line2)"};border-radius:10px;overflow:hidden;cursor:pointer;background:#14161f;${on ? "box-shadow:0 0 0 2px var(--ind-s)" : ""}`;
    const stage = document.createElement("div");
    stage.style.cssText = "height:48px;position:relative;pointer-events:none";
    const cap = document.createElement("div");
    cap.style.cssText = `font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${on ? "var(--ind)" : "var(--faint)"};padding:4px 0;text-align:center;background:var(--sub)`;
    cap.textContent = eff;
    tile.append(stage, cap);
    tile.onclick = () => { o.effect = eff; markDirty(); renderView(); };
    g.appendChild(tile);
    if (overlayEngine) {
      const tcfg = { ...o, effect: eff, anchor: "center", lineCount: 1, fontSize: 46, motion: "instant" };
      setTimeout(() => overlayEngine.mountPreview(stage, tcfg, { checker: false, refW: 360 })([{ time: 0, text: "Abc" }], 0), 0);
    }
  }
  wrap.appendChild(g);
  return wrap;
}

function overlayTabBody(tab) {
  const o = state.cfg.overlay;
  if (tab === "layout") {
    const g = grid("1fr 1fr");
    g.append(
      ovSelect("Visible lines", o.lineCount, OV_LINES, (v) => o.lineCount = Number(v)),
      ovNum("Timing offset (ms)", o.timingOffsetMs, (v) => o.timingOffsetMs = v),
      ovIconGroup("Alignment", o.alignment, ALIGN_OPTS, (v) => o.alignment = v),
      ovIconGroup("Anchor", o.anchor, ANCHOR_OPTS, (v) => o.anchor = v),
    );
    return g;
  }
  if (tab === "text") {
    const g = grid("1fr 1fr");
    g.append(
      ovSelect("Font", o.font, OV_FONTS, (v) => o.font = v),
      ovNum("Font size (px)", o.fontSize, (v) => o.fontSize = v),
      ovColour("Current line", o.color, (v) => o.color = v),
      ovColour("Other lines", o.neighbourColor, (v) => o.neighbourColor = v),
      ovRange("Other-line opacity", o.dimOpacity, 0, 1, 0.05, (v) => o.dimOpacity = v, (v) => v.toFixed(2)),
    );
    return g;
  }
  // motion & fx
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:18px";
  const g = grid("1fr 1fr");
  g.append(
    ovSelect("Motion", o.motion, OV_MOTION, (v) => o.motion = v),
    ovSelect("Easing", o.easing, OV_EASING, (v) => o.easing = v),
    ovRange("Transition (ms)", o.transitionMs, 0, 1000, 50, (v) => o.transitionMs = v),
  );
  const fg = grid("1fr 1fr");
  fg.append(
    ovColour("Effect colour", o.fxColor, (v) => o.fxColor = v),
    ovRange("Intensity", o.fxIntensity, 0, 100, 1, (v) => o.fxIntensity = v),
    ovRange("Speed (ms)", o.fxDurMs, 200, 4000, 100, (v) => o.fxDurMs = v),
  );
  wrap.append(g, effectGallery(), fg);
  return wrap;
}

function buildOverlay(view) {
  const wrap = document.createElement("div");
  wrap.className = "ovwrap";
  wrap.style.cssText = "display:grid;grid-template-columns:440px 1fr;gap:22px;align-items:start";

  // controls — one flat card, no inner boxes
  const side = document.createElement("div");
  side.className = "card";
  side.style.cssText = "padding:20px";

  // header — card title + live lyric status, so the panel has a clear heading.
  const head = document.createElement("div");
  head.className = "row";
  head.style.cssText = "justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px";
  head.innerHTML = '<div style="font-family:var(--disp);font-size:16px;font-weight:700">Overlay</div>';
  const status = document.createElement("div");
  status.id = "ovbStatus";
  status.className = "pill";
  status.style.cssText = "background:var(--sub);color:var(--dim)";
  head.appendChild(status);
  side.appendChild(head);

  const seg = document.createElement("div");
  seg.style.cssText = "display:flex;background:var(--sub);border:1px solid var(--line2);border-radius:11px;padding:3px;gap:2px;margin-bottom:20px";
  for (const [k, label] of [["layout", "Layout"], ["text", "Text"], ["motion", "Motion & FX"]]) {
    const on = state.ovTab === k;
    const t = document.createElement("button");
    t.textContent = label;
    t.style.cssText = `flex:1;font-family:var(--sans);font-size:13px;font-weight:600;padding:8px;border:none;border-radius:8px;cursor:pointer;` +
      (on ? "background:var(--card);color:var(--ind);box-shadow:var(--sh)" : "background:transparent;color:var(--dim)");
    t.onclick = () => { state.ovTab = k; renderView(); };
    seg.appendChild(t);
  }
  side.appendChild(seg);
  side.appendChild(overlayTabBody(state.ovTab));

  // OBS output — its own block so "what you paste into OBS" reads as a distinct
  // step from the styling controls above.
  const obs = document.createElement("div");
  obs.style.cssText = "margin-top:20px;padding:16px;background:var(--sub);border:1px solid var(--line);border-radius:12px";
  obs.innerHTML = '<div class="flabel" style="margin:0 0 8px">OBS browser source URL</div>';
  const url = document.createElement("input");
  url.className = "field ro"; url.readOnly = true; url.value = `${location.origin}/overlay`;
  url.style.cssText = "font-size:12.5px;background:var(--card)";
  const btns = document.createElement("div"); btns.className = "row"; btns.style.cssText = "gap:8px;margin-top:10px";
  const copy = document.createElement("button"); copy.className = "btn"; copy.style.flex = "1"; copy.textContent = "Copy URL";
  copy.onclick = async () => { try { await navigator.clipboard.writeText(url.value); } catch { url.select(); document.execCommand("copy"); } copy.textContent = "Copied!"; setTimeout(() => copy.textContent = "Copy URL", 1500); };
  const open = document.createElement("button"); open.className = "btn"; open.style.flex = "1"; open.textContent = "Open ↗";
  open.onclick = () => window.open(url.value, "_blank");
  btns.append(copy, open);
  obs.append(url, btns);
  side.appendChild(obs);

  // preview — top-aligned with the controls card (the checkerboard marks it live).
  const prev = document.createElement("div");
  prev.id = "ovbPreview";
  prev.style.cssText = "border-radius:14px;overflow:hidden;width:100%;aspect-ratio:16/9;max-height:72vh;border:1px solid var(--line)";

  wrap.append(side, prev);
  view.appendChild(wrap);
  updateLyricsStatusUI();
  setTimeout(() => { remountPreview(); ensurePreviewLyrics(); }, 0);
}

// Preview the current track's real synced lyrics at the live playback position when
// available; otherwise a sample. Returns {lines, idx}.
function previewFrame() {
  const pl = state.previewLyrics;
  if (pl.lines && pl.lines.length) {
    const off = (Number(state.cfg.overlay.timingOffsetMs) || 0) / 1000;
    // idx may be -1 before the first line's timestamp — render() clears then, so no
    // line reads as active until playback actually reaches it (don't clamp to 0).
    const idx = overlayEngine ? overlayEngine.currentIndex(pl.lines, nowMs() / 1000 + off) : -1;
    return { lines: pl.lines, idx };
  }
  return { lines: PREVIEW_LINES, idx: PREVIEW_IDX };
}

// Guards tickPreview: only re-render when the active line (or the lyric set) changes,
// so the 500ms tick doesn't rebuild the preview — and flicker — every second.
let pvLastIdx = -2, pvLastLines = null;

// Re-mount the preview (reflects a style change) and render the current frame; keep
// the handle so position ticks advance it smoothly without re-mounting.
function remountPreview() {
  const el = $("ovbPreview");
  if (!el || !overlayEngine) return;
  state.previewRender = overlayEngine.mountPreview(el, state.cfg.overlay);
  const { lines, idx } = previewFrame();
  state.previewRender(lines, idx);
  pvLastIdx = idx; pvLastLines = lines;
}

// Advance the mounted preview to the current line — no re-mount, so it scrolls live.
function tickPreview() {
  if (state.view !== "overlay" || !state.previewRender) return;
  const { lines, idx } = previewFrame();
  if (idx === pvLastIdx && lines === pvLastLines) return;
  pvLastIdx = idx; pvLastLines = lines;
  state.previewRender(lines, idx);
}

const refreshPreview = remountPreview;

function updateLyricsStatusUI() {
  const el = $("ovbStatus");
  if (!el) return;
  const map = {
    checking: ["Checking lyrics…", "var(--sub)", "var(--dim)"],
    available: ["Lyrics available", "var(--ok-s)", "var(--ok)"],
    none: ["No synced lyrics for this track", "var(--warn-s)", "var(--warn)"],
    notrack: ["No track playing — showing sample", "var(--sub)", "var(--dim)"],
    idle: ["Checking lyrics…", "var(--sub)", "var(--dim)"],
  };
  const [text, bg, fg] = map[state.previewLyrics.status] || map.idle;
  el.innerHTML = `<span class="dot" style="background:${fg}"></span>${esc(text)}`;
  el.style.background = bg; el.style.color = fg;
}

async function ensurePreviewLyrics() {
  if (!overlayEngine) return;
  const t = pb.track;
  if (!t) { state.previewLyrics = { uri: null, lines: [], status: "notrack" }; updateLyricsStatusUI(); remountPreview(); return; }
  const key = t.uri || `${t.artist}|${t.title}`;
  if (state.previewLyrics.uri === key && state.previewLyrics.status !== "idle") { updateLyricsStatusUI(); return; }
  state.previewLyrics = { uri: key, lines: [], status: "checking" };
  updateLyricsStatusUI();
  let lines = null;
  try { lines = await overlayEngine.fetchSyncedLyrics(t); } catch { lines = null; }
  const nowKey = pb.track && (pb.track.uri || `${pb.track.artist}|${pb.track.title}`);
  if (nowKey !== key) return; // track changed mid-fetch
  state.previewLyrics = { uri: key, lines: lines || [], status: lines && lines.length ? "available" : "none" };
  updateLyricsStatusUI();
  remountPreview();
}

// ---- dirty / save ----
function markDirty() {
  state.dirty = true;
  $("saveBar").classList.remove("hidden");
  $("cfgMsg").textContent = "Unsaved changes";
  $("cfgMsg").style.color = "var(--warn)";
}

async function save() {
  $("cfgSave").disabled = true;
  $("cfgMsg").textContent = "Saving…"; $("cfgMsg").style.color = "var(--dim)";
  try {
    const updated = await api("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.cfg),
    });
    state.cfg = updated;
    captureSecrets();
    state.dirty = false;
    $("cfgMsg").textContent = "Saved"; $("cfgMsg").style.color = "var(--ok)";
    await Promise.all([refreshSummary(), refreshSinks()]);
    renderView(); renderBanner();
    setTimeout(() => { if (!state.dirty) $("saveBar").classList.add("hidden"); }, 1200);
  } catch (err) {
    $("cfgMsg").textContent = err instanceof Error && err.message.includes("400") ? "Rejected — check values" : "Save failed";
    $("cfgMsg").style.color = "var(--bad)";
  } finally {
    $("cfgSave").disabled = false;
  }
}

async function discard() {
  state.cfg = await api("/api/config");
  captureSecrets();
  state.dirty = false;
  $("cfgMsg").textContent = ""; $("saveBar").classList.add("hidden");
  renderView();
}

// ---- banner + summary ----
function renderBanner() {
  $("banner").classList.toggle("hidden", !state.summary.pendingRestart);
}

async function refreshSummary() {
  state.summary = await api("/api/config-summary");
}

async function refreshSinks() {
  try { state.sinks = await api("/api/pipewire-sinks"); } catch { state.sinks = []; }
}

function wireStatic() {
  $("snapweb").href = `http://${location.hostname}:1780`;
  $("mpPlay").onclick = () => sendCommand(pb.playing ? "pause" : "play");
  $("mpNext").onclick = () => sendCommand("skip_next");
  $("mpPrev").onclick = () => sendCommand("skip_prev");
  $("cfgSave").onclick = save;
  $("cfgDiscard").onclick = discard;
  $("restartBtn").onclick = async () => {
    $("restartBtn").disabled = true;
    try { await api("/api/restart-soloist", { method: "POST" }); await refreshSummary(); renderBanner(); }
    finally { $("restartBtn").disabled = false; }
  };
  setInterval(() => { if (pb.track) renderNowPlaying(); tickPreview(); }, 500);
}

async function boot() {
  const [cfg, summary, webhooks] = await Promise.all([
    api("/api/config"),
    api("/api/config-summary"),
    api("/api/webhooks"),
  ]);
  state.cfg = cfg;
  state.summary = summary;
  state.webhooks = webhooks;
  captureSecrets();
  await refreshSinks();
  await loadOverlayEngine();
  wireStatic();
  renderNav();
  renderView();
  renderBanner();
  renderNowPlaying();
  connectWs();
}

if (typeof window !== "undefined" && document.getElementById("view")) {
  boot().catch((err) => console.error("landing boot failed", err));
}
