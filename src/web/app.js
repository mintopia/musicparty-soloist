// Landing Page controller/orchestrator: nav/routing, boot/save/discard, and the
// Now/Audio/Webhooks/Settings page builders. Playback state + WS wiring lives in
// playback.js, the Soloist wire format + anchor math in frame.js, the form-widget
// kit in widgets.js, and the Lyrics tab (config editor + preview) in
// overlay-panel.js — this file wires them together.
//
// Pure view-model helpers (fmtTime, readTrack, readPlayback, readQueue) are
// re-exported below so they stay importable in Node for the selftest; the DOM + WS
// wiring boots only in the browser (guarded at the bottom).
//
// Auth: the page is same-origin, so the Web Session cookie rides the WS
// handshake automatically — checkAuth() falls through to sessionUser() and the
// socket lands in the control tier. No token in the URL.

import { pb, nowMs, isStale, fmtTime, connectWs, sendCommand } from "./playback.js";
import { grid, formCol, sectionCard, field, settingRow, secretRow as secretRowWidget } from "./widgets.js";
import { createOverlayPanel } from "./overlay-panel.js";

// Re-exported so selftest.ts's dynamic `import("./web/app.js")` still finds these
// view-model helpers at the top level.
export { readTrack, readPlayback } from "./frame.js";
export { fmtTime, readQueue } from "./playback.js";
export { hexToHsl, hslToHex } from "./widgets.js";

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
  relay: null,
  sinks: [],
  dirty: false,
  view: "now",
  ovTab: "layout",
  previewLyrics: { uri: null, lines: [], status: "idle" }, // status: idle|checking|available|none|notrack
  previewRender: null,
};

const panel = createOverlayPanel({ state, markDirty, renderView, pb, nowMs });

// Adapter over widgets.js's dependency-free secretRow: binds it to this app's
// `state.cfg`/`state.secretSet`/markDirty/api so call sites keep the original
// (label, section, key, opts) shape.
function secretRow(label, section, key, opts = {}) {
  return secretRowWidget(label, {
    isSet: state.secretSet[`${section}.${key}`],
    get: () => state.cfg[section][key],
    set: (v) => { state.cfg[section][key] = v; },
    onDirty: markDirty,
    reveal: opts.reveal ? () => api(`/api/secret?section=${section}&key=${key}`).then((r) => r.value) : undefined,
  });
}

// Set clip's text, and if it overflows, ping-pong scroll it (pausing at each end).
// Idempotent per element+text so the 500ms render tick doesn't restart the scroll.
const scrollingClips = new Set();
function setScrollingText(clip, text) {
  const t = text || "";
  scrollingClips.add(clip);
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
  animateMarquee(clip, span);
}

function animateMarquee(clip, span) {
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

// Recompute overflow for every mounted marquee on resize (a title can clip after a
// window resize otherwise). One listener for the page's lifetime, debounced.
let resizeTimer = null;
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const clip of scrollingClips) {
        if (!clip.isConnected) { scrollingClips.delete(clip); continue; }
        const span = clip.firstElementChild;
        if (span && span.classList.contains("mq")) animateMarquee(clip, span);
      }
    }, 150);
  });
}

function renderNowPlaying() {
  const t = pb.track;
  const stale = isStale();
  const posBasis = stale ? pb.anchorMs : nowMs();
  // mini player (top bar) — always
  const mp = $("miniPlayer");
  if (mp) {
    mp.classList.toggle("hidden", !t);
    mp.style.opacity = stale ? "0.55" : "";
    if (t) {
      setScrollingText($("mpTitle"), t.title || "Untitled");
      $("mpArtist").textContent = t.artist || "—";
      $("mpArt").style.backgroundImage = t.art ? `url("${encodeURI(t.art)}")` : "";
      $("mpPlayIcon").innerHTML = pb.playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
      const dur = t.durationMs || 0;
      $("mpProg").style.width = (dur ? Math.min(100, Math.max(0, (Math.min(posBasis, dur) / dur) * 100)) : 0) + "%";
      if (pb.volume !== null) {
        const vp = $("mpVolPop"), vr = $("mpVolRange");
        // Don't fight the user's drag: only sync the slider while the popover is closed.
        if (vr && !(vp && vp.classList.contains("open"))) { vr.value = pb.volume; $("mpVolVal").textContent = String(Math.round(pb.volume)); }
        const mi = $("mpVolIcon");
        if (mi) mi.innerHTML = pb.volume === 0
          ? '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>'
          : '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>';
      }
    }
  }
  if (!$("npTitle")) return; // Now view not mounted

  $("npStatus").textContent = t ? (pb.playing ? "Now playing" : "Paused") : "Idle";
  $("npDot").style.background = t && pb.playing ? "#34d399" : "#6b6b72";
  $("npDot").style.boxShadow = t && pb.playing ? "0 0 8px #34d399" : "none";
  setScrollingText($("npTitle"), t ? t.title || "Untitled" : "Nothing playing");
  $("npArtist").textContent = t ? [t.artist, t.album].filter(Boolean).join(" — ") || "—" : "—";
  $("npArt").style.backgroundImage = t && t.art ? `url("${encodeURI(t.art)}")` : "";
  $("npArt").style.opacity = stale ? "0.55" : "";
  $("playIcon").innerHTML = pb.playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  const chips = $("npChips");
  chips.innerHTML = "";
  if (t) for (const c of [t.album && "◆ " + t.album].filter(Boolean)) {
    const s = document.createElement("span"); s.className = "hchip"; s.textContent = c; chips.appendChild(s);
  }
  const dur = t ? t.durationMs : 0;
  const pos = Math.min(posBasis, dur || Infinity);
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  $("npFill").style.inset = `0 ${100 - pct}% 0 0`;
  $("npHandle").style.left = `${pct}%`;
  $("npPos").textContent = fmtTime(pos);
  $("npDur").textContent = fmtTime(dur);
  $("npBar").style.opacity = stale ? "0.55" : "";
  if (pb.volume !== null) {
    const v = Math.max(0, Math.min(100, pb.volume));
    $("volFill").style.inset = `0 ${100 - v}% 0 0`;
    $("volHandle").style.left = `${v}%`;
  }
  $("btnShuffle").classList.toggle("act", pb.shuffle);
  renderRepeat();
}

// Three visually distinct states (item 4): off (dim arrows), context/all (accent
// arrows), track/one (accent arrows + centred "1", Spotify-style).
const REPEAT_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
function renderRepeat() {
  const b = $("btnRepeat");
  if (!b) return;
  b.classList.toggle("act", pb.repeat !== "off");
  b.style.position = "relative";
  b.innerHTML = REPEAT_SVG + (pb.repeat === "track"
    ? '<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:9px;font-weight:800;line-height:1">1</span>' : "");
  b.title = pb.repeat === "track" ? "Repeat: one" : pb.repeat === "context" ? "Repeat: all" : "Repeat: off";
}

// Titlebar marker (item 1): lights the mini-player badge when the current track has
// synced lyrics. Reuses the overlay engine's lrclib fetch (localStorage-cached, so
// repeat plays are free) and is keyed per track so it fires once per change.
let lyricsMarkKey = null;
async function checkTrackLyrics() {
  const mark = $("mpLyrics");
  const t = pb.track;
  if (!t) { lyricsMarkKey = null; if (mark) mark.classList.remove("on"); return; }
  const key = t.uri || `${t.artist}|${t.title}`;
  if (key === lyricsMarkKey) return;
  lyricsMarkKey = key;
  if (mark) mark.classList.remove("on");
  const engine = panel.getOverlayEngine();
  if (!engine) return;
  let lines = null;
  try { lines = await engine.fetchSyncedLyrics(t); } catch { lines = null; }
  const nowKey = pb.track && (pb.track.uri || `${pb.track.artist}|${pb.track.title}`);
  if (nowKey !== key) return; // track changed mid-fetch
  if (mark) mark.classList.toggle("on", !!(lines && lines.length));
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

const VIEWS = [
  { key: "now", label: "Now Playing" },
  { key: "audio", label: "Audio" },
  { key: "webhooks", label: "Webhooks" },
  { key: "overlay", label: "Lyrics" },
  { key: "settings", label: "Settings" },
];

// View <-> URL path (item 11). Must match the app-shell paths the server serves (web.ts APP_PATHS).
const VIEW_PATHS = { now: "/", audio: "/audio", webhooks: "/webhooks", overlay: "/lyrics", settings: "/settings" };
const pathToView = (p) => Object.keys(VIEW_PATHS).find((k) => VIEW_PATHS[k] === p) || "now";

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

function setView(v, push = true) {
  state.view = v;
  if (push) {
    const path = VIEW_PATHS[v] || "/";
    if (location.pathname !== path) history.pushState({ view: v }, "", path);
  }
  renderNav();
  renderView();
  if (v === "settings") refreshRelay(); // immediate fresh status on entering the tab
}

function renderView() {
  const view = $("view");
  view.innerHTML = "";
  if (state.view === "now") buildNow(view);
  else if (state.view === "audio") buildAudio(view);
  else if (state.view === "webhooks") buildWebhooks(view);
  else if (state.view === "overlay") panel.buildOverlay(view);
  else if (state.view === "settings") buildSettings(view);
}

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
            <div id="volBar" style="width:96px;height:6px;border-radius:4px;background:rgba(255,255,255,.16);position:relative;cursor:pointer;margin-right:2px">
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

function captureSecrets() {
  state.secretSet = {};
  for (const [s, k] of [["soloist", "apiKey"], ["proxy", "token"], ["webhooks", "secret"], ["relay", "authorization"], ["web", "password"]]) {
    state.secretSet[`${s}.${k}`] = state.cfg[s][k] === true;
  }
}

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
    const tile = `<div style="width:38px;height:38px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:${on ? "var(--ind)" : "var(--line)"};color:${on ? "#fff" : "var(--faint)"}"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${isSnap ? ICON_SNAP : ICON_HW}</svg></div>`;
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
    // Hardware sinks get a playback delay knob, to push a local DAC late for sync.
    if (!isSnap && on) {
      const sub = document.createElement("div");
      sub.style.cssText = "padding:12px 14px;border-top:1px solid rgba(13,148,136,.22)";
      const df = field("Delay (ms)", c.audio.outputDelays[sink.name] || 0, (v) => { c.audio.outputDelays[sink.name] = Number(v) || 0; markDirty(); }, { type: "number" });
      df.style.maxWidth = "160px";
      sub.appendChild(df);
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

function buildSettings(view) {
  const c = state.cfg;
  const col = formCol();
  const soloist = sectionCard("Soloist");
  const g = grid("1fr 1fr");
  const cells = [field("Device name", c.soloist.deviceName, (v) => { c.soloist.deviceName = v; markDirty(); })];
  // In Docker, Soloist runs inside the container on a fixed local WS — the address
  // isn't operator-editable, so hide the field (item 9).
  if (!state.summary.dockerMode) cells.push(field("Soloist WS", c.soloistWs, (v) => { c.soloistWs = v; markDirty(); }));
  cells.push(secretRow("Spotify API key", "soloist", "apiKey", { reveal: true }));
  cells.push(secretRow("WebSocket auth token", "proxy", "token", { reveal: true }));
  g.append(...cells);
  soloist.appendChild(g);
  soloist.appendChild(settingRow(
    "Autoplay on login",
    "Start playback automatically once Soloist signs in.",
    c.autoplay,
    () => { c.autoplay = !c.autoplay; markDirty(); renderView(); },
  ));
  col.appendChild(soloist);

  const relay = sectionCard("WebSocket relay", "Bridge Soloist to an external server: outbound frames are republished, received frames are relayed back as commands.");
  const relayHead = document.createElement("div");
  relayHead.id = "relayStatusHead";
  relayHead.className = "row"; relayHead.style.cssText = "justify-content:flex-end;margin-bottom:14px";
  relayHead.appendChild(relayStatusPill());
  relay.appendChild(relayHead);
  const rg = grid("1fr 1fr");
  rg.append(
    field("Relay URL", c.relay.url, (v) => { c.relay.url = v; markDirty(); }, { placeholder: "wss://example.com/relay" }),
    secretRow("Authorization header", "relay", "authorization", { reveal: true }),
  );
  relay.appendChild(rg);
  col.appendChild(relay);

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

// Relay connection state from GET /api/relay: disabled | connected | reconnecting,
// with the last error when reconnecting.
function relayStatusPill() {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:4px";
  const s = state.relay?.status || { enabled: false, connected: false, lastError: null };
  let bg, fg, text;
  if (!s.enabled) { bg = "var(--sub)"; fg = "var(--dim)"; text = "Disabled"; }
  else if (s.connected) { bg = "var(--ok-s)"; fg = "var(--ok)"; text = "Connected"; }
  else { bg = "var(--warn-s)"; fg = "var(--warn)"; text = "Reconnecting…"; }
  const pill = document.createElement("span");
  pill.className = "pill"; pill.style.cssText = `background:${bg};color:${fg}`;
  pill.innerHTML = `<span class="dot" style="background:${fg}"></span>${esc(text)}`;
  wrap.appendChild(pill);
  if (s.enabled && !s.connected && s.lastError) {
    const err = document.createElement("div");
    err.style.cssText = "font-size:11.5px;color:var(--faint);max-width:340px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    err.textContent = s.lastError;
    wrap.appendChild(err);
  }
  return wrap;
}

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
    await Promise.all([refreshSummary(), refreshSinks(), refreshRelay(), refreshWebhooks()]);
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

function renderBanner() {
  $("banner").classList.toggle("hidden", !state.summary.pendingRestart);
}

async function refreshSummary() {
  state.summary = await api("/api/config-summary");
}

async function refreshSinks() {
  try { state.sinks = await api("/api/pipewire-sinks"); } catch { state.sinks = []; }
}

async function refreshWebhooks() {
  try { state.webhooks = await api("/api/webhooks"); } catch {}
}

// Relay status is live (connecting/connected/reconnecting) — refresh it and, if the
// Settings view is mounted, swap the pill in place without rebuilding the form.
async function refreshRelay() {
  try { state.relay = await api("/api/relay"); } catch { return; }
  const head = $("relayStatusHead");
  if (head) { head.innerHTML = ""; head.appendChild(relayStatusPill()); }
}

function applyThemeIcon() {
  const b = $("themeBtn");
  if (!b) return;
  const dark = document.documentElement.dataset.theme === "dark";
  b.innerHTML = dark
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("soloist-theme", next); } catch { /* private mode */ }
  applyThemeIcon();
}

function wireStatic() {
  $("snapweb").href = `http://${location.hostname}:1780`;
  $("mpPlay").onclick = () => sendCommand(pb.playing ? "pause" : "play");
  $("mpNext").onclick = () => sendCommand("skip_next");
  $("mpPrev").onclick = () => sendCommand("skip_prev");
  $("themeBtn").onclick = toggleTheme;
  applyThemeIcon();
  // Mini-player volume dropdown (item 2).
  const volPop = $("mpVolPop"), volRange = $("mpVolRange");
  $("mpVolBtn").onclick = (e) => {
    e.stopPropagation();
    if (volPop.classList.toggle("open")) {
      const r = e.currentTarget.getBoundingClientRect();
      volPop.style.top = `${r.bottom + 8}px`;
      volPop.style.right = `${window.innerWidth - r.right}px`;
    }
  };
  volRange.oninput = () => { $("mpVolVal").textContent = volRange.value; sendCommand("set_volume", { volume: Number(volRange.value) }); };
  document.addEventListener("click", (e) => { if (!e.target.closest(".mpvol")) volPop.classList.remove("open"); });
  // Back/forward through client-routed views (item 11).
  window.addEventListener("popstate", () => setView(pathToView(location.pathname), false));
  $("cfgSave").onclick = save;
  $("cfgDiscard").onclick = discard;
  $("restartBtn").onclick = async () => {
    $("restartBtn").disabled = true;
    try { await api("/api/restart-soloist", { method: "POST" }); await refreshSummary(); renderBanner(); }
    finally { $("restartBtn").disabled = false; }
  };
  setInterval(() => { if (pb.track) renderNowPlaying(); panel.tickPreview(); }, 500);
  // Live-ish relay status only while the Settings tab is open.
  setInterval(() => { if (state.view === "settings") refreshRelay(); }, 3000);
}

async function boot() {
  const [cfg, summary, webhooks, relay] = await Promise.all([
    api("/api/config"),
    api("/api/config-summary"),
    api("/api/webhooks"),
    api("/api/relay"),
  ]);
  state.cfg = cfg;
  state.summary = summary;
  state.webhooks = webhooks;
  state.relay = relay;
  captureSecrets();
  await refreshSinks();
  await panel.loadOverlayEngine();
  wireStatic();
  state.view = pathToView(location.pathname); // deep-link straight to the routed view (item 11)
  renderNav();
  renderView();
  renderBanner();
  renderNowPlaying();
  connectWs((msg, delta) => {
    if (delta.track) { checkTrackLyrics(); if (state.view === "overlay") panel.ensurePreviewLyrics(); }
    if (delta.queue) renderQueue();
    renderNowPlaying();
  });
}

if (typeof window !== "undefined" && document.getElementById("view")) {
  boot().catch((err) => console.error("landing boot failed", err));
}
