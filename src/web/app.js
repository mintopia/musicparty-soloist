// Landing Page controller. Pure view-model helpers (fmtTime, readTrack,
// readPlayback, readQueue) are importable in Node for the selftest; the DOM +
// WS wiring boots only in the browser (guarded at the bottom).
//
// Auth: the page is same-origin, so the Web Session cookie rides the WS
// handshake automatically — checkAuth() falls through to sessionUser() and the
// socket lands in the control tier. No token in the URL.

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Soloist's frame schema isn't pinned (see overlay.js), so read plausible shapes
// defensively; an unreadable frame leaves prior state in place.
export function readTrack(msg) {
  const t = (msg && typeof msg.track === "object" && msg.track) || msg || {};
  const title = t.name || t.title || msg.name || msg.title || "";
  let artist = "";
  const artists = t.artists || msg.artists;
  if (Array.isArray(artists)) artist = artists.map((a) => (typeof a === "string" ? a : a && a.name) || "").filter(Boolean).join(", ");
  else artist = t.artist || msg.artist || (typeof artists === "string" ? artists : "");
  const album = (t.album && (t.album.name || t.album)) || msg.album || "";
  const durationMs = Number(t.duration_ms ?? t.duration ?? msg.duration_ms ?? msg.duration ?? 0) || 0;
  const art = readArt(t.album) || readArt(t) || readArt(msg) || "";
  if (!title && !artist) return null;
  return { title, artist, album: typeof album === "string" ? album : "", durationMs, art };
}

function readArt(o) {
  if (!o || typeof o !== "object") return "";
  if (typeof o.image === "string") return o.image;
  if (typeof o.artwork_url === "string") return o.artwork_url;
  const imgs = o.images;
  if (Array.isArray(imgs) && imgs.length) return imgs[0]?.url || imgs[0] || "";
  return "";
}

export function readPlayback(msg) {
  const positionMs = Number(msg.position_ms ?? msg.position ?? msg.progress_ms ?? NaN);
  let playing;
  if (typeof msg.playing === "boolean") playing = msg.playing;
  else if (typeof msg.is_playing === "boolean") playing = msg.is_playing;
  else if (typeof msg.paused === "boolean") playing = !msg.paused;
  const volume = Number(msg.volume ?? msg.volume_percent ?? NaN);
  return {
    positionMs: Number.isNaN(positionMs) ? null : positionMs,
    playing,
    volume: Number.isNaN(volume) ? null : volume,
  };
}

// A queue_changed / state frame -> [{title, artist, durationMs, art}]. Accepts the
// list under any of the plausible keys; each item is read like a track.
export function readQueue(msg) {
  const list = msg.queue || msg.items || msg.tracks || msg.next || (Array.isArray(msg) ? msg : null);
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const t = readTrack(item && typeof item === "object" ? item : {});
    out.push(t || { title: String(item ?? ""), artist: "", durationMs: 0, art: "" });
  }
  return out;
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
  section: "soloist",
};

// ---- playback state fed by the WS ----
const pb = { track: null, queue: [], playing: false, posMs: 0, posAt: 0, volume: null };

function nowMs() {
  return pb.playing ? pb.posMs + (performance.now() - pb.posAt) : pb.posMs;
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

// Soloist commands are {type:"command", command:…} (see AUTOPLAY_FRAMES). The proxy
// relays them verbatim; play/activate are confirmed, the rest follow the same shape
// and Soloist ignores unknown commands, so unsupported controls are harmless no-ops.
function sendCommand(command, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "command", command, ...(extra || {}) }));
}

function onFrame(msg) {
  const t = readTrack(msg);
  if (t) pb.track = t;
  const q = readQueue(msg);
  if (q) { pb.queue = q; renderQueue(); }
  const p = readPlayback(msg);
  if (p.positionMs !== null) { pb.posMs = p.positionMs; pb.posAt = performance.now(); }
  if (typeof p.playing === "boolean") {
    if (p.playing && !pb.playing) pb.posAt = performance.now();
    else if (!p.playing && pb.playing) pb.posMs = nowMs();
    pb.playing = p.playing;
  }
  if (p.volume !== null) pb.volume = p.volume;
  renderNowPlaying();
}

function setWsPill(up) {
  const el = $("wsPill");
  el.style.background = up ? "var(--ok-s)" : "var(--warn-s)";
  el.style.color = up ? "var(--ok)" : "var(--warn)";
  el.innerHTML = `<span class="dot" style="background:${up ? "var(--ok)" : "var(--warn)"}"></span>${up ? "Connected" : "Disconnected"}`;
}

function renderNowPlaying() {
  const t = pb.track;
  $("npStatus").textContent = t ? (pb.playing ? "Now playing" : "Paused") : "Idle";
  $("npDot").style.background = t && pb.playing ? "#34d399" : "#6b6b72";
  $("npDot").style.boxShadow = t && pb.playing ? "0 0 8px #34d399" : "none";
  $("npTitle").textContent = t ? t.title || "Untitled" : "Nothing playing";
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
}

function renderQueue() {
  const list = $("qList");
  const q = pb.queue;
  $("qCount").textContent = String(q.length);
  list.querySelectorAll(".qrowd").forEach((n) => n.remove());
  $("qEmpty").style.display = q.length ? "none" : "block";
  q.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "row qrowd";
    row.style.cssText = "gap:11px;padding:8px 10px";
    row.innerHTML =
      `<span style="width:15px;text-align:center;font-size:12px;color:rgba(255,255,255,.38);font-weight:600">${i + 1}</span>` +
      `<div style="width:36px;height:36px;border-radius:7px;flex:0 0 auto;background:${t.art ? `url('${encodeURI(t.art)}') center/cover` : "linear-gradient(135deg,#5eead4,#22d3ee)"}"></div>` +
      `<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div><div style="font-size:12px;color:rgba(255,255,255,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist)}</div></div>` +
      `<span style="font-size:11.5px;color:rgba(255,255,255,.4)">${t.durationMs ? fmtTime(t.durationMs) : ""}</span>` +
      `<button class="qxd" title="Remove from queue">×</button>`;
    row.querySelector(".qxd").onclick = () => sendCommand("remove_from_queue", { index: i });
    list.appendChild(row);
  });
}

// ---- outputs / webhooks / overlay data panel ----
function renderOutputs() {
  const el = $("outList");
  el.innerHTML = "";
  const selected = new Set(state.cfg.audio.outputs);
  for (const sink of state.sinks) {
    const isSnap = sink.name === "snapcast";
    const on = isSnap ? state.cfg.audio.snapcast : selected.has(sink.name);
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "space-between";
    row.innerHTML =
      `<div class="row" style="gap:10px"><span class="dot" style="background:${on ? "var(--ok)" : "var(--faint)"}"></span><span style="font-size:14px;font-weight:500;${on ? "" : "color:var(--dim)"}">${esc(sink.description)}</span></div>` +
      `<div class="sw ${on ? "on" : "off"}"><i></i></div>`;
    row.querySelector(".sw").onclick = () => toggleOutput(sink.name, isSnap);
    el.appendChild(row);
  }
  if (!state.sinks.length) el.innerHTML = '<div style="font-size:13px;color:var(--faint)">No sinks reported.</div>';
}

function toggleOutput(name, isSnap) {
  if (isSnap) state.cfg.audio.snapcast = !state.cfg.audio.snapcast;
  else {
    const outs = state.cfg.audio.outputs;
    const i = outs.indexOf(name);
    if (i >= 0) outs.splice(i, 1); else outs.push(name);
  }
  markDirty();
  renderOutputs();
  if (state.section === "audio") renderPanel();
}

function renderWebhooks() {
  const el = $("whList");
  el.innerHTML = "";
  const wh = state.webhooks;
  const entries = [];
  if (wh.config.defaultUrl) entries.push(["default", wh.config.defaultUrl]);
  for (const [k, v] of Object.entries(wh.config.urls || {})) entries.push([k, v]);
  if (!entries.length) { el.innerHTML = '<div style="font-size:13px;color:var(--faint)">No webhooks configured.</div>'; return; }
  entries.forEach(([name, url], i) => {
    const s = wh.stats[url];
    let pill = '<span class="pill" style="background:var(--sub);color:var(--dim)">no deliveries</span>';
    if (s) {
      const bad = s.fail > 0 && (s.lastStatus === null || s.lastStatus >= 400);
      const label = `${s.lastStatus ?? "err"} · ${s.ok}✓${s.fail ? " " + s.fail + "✗" : ""}`;
      pill = `<span class="pill" style="background:${bad ? "var(--bad-s)" : "var(--ok-s)"};color:${bad ? "var(--bad)" : "var(--ok)"}">${esc(label)}</span>`;
    }
    if (i > 0) { const hr = document.createElement("div"); hr.style.cssText = "height:1px;background:var(--line)"; el.appendChild(hr); }
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "space-between";
    row.innerHTML = `<div style="min-width:0"><div style="font-size:14px;font-weight:600">${esc(name)}</div><div style="font-size:12px;color:var(--faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px">${esc(url)}</div></div>${pill}`;
    el.appendChild(row);
  });
}

// Sample lines so the operator sees their style choices without live lyrics.
const PREVIEW_LINES = [
  { time: 0, text: "I'm blinded by the lights" },
  { time: 1, text: "Can't sleep until I feel your touch" },
  { time: 2, text: "drowning in the night" },
];

let overlayEngine = null;
async function loadOverlayEngine() {
  if (!overlayEngine) overlayEngine = await import("/overlay.js");
  return overlayEngine;
}

async function renderOverlayPreview(root) {
  const eng = await loadOverlayEngine();
  root.innerHTML = "";
  root.style.position = "relative";
  eng.makeRenderer(root, state.cfg.overlay)(PREVIEW_LINES, 1);
}

function renderMiniOverlay() {
  renderOverlayPreview($("ovPreview"));
}

// ---- configuration editor ----
const SECTIONS = [
  { key: "soloist", label: "Soloist" },
  { key: "audio", label: "Audio outputs" },
  { key: "web", label: "Web access" },
  { key: "webhooks", label: "Webhooks" },
  { key: "overlay", label: "Overlay" },
];

const NAV_ICON = {
  soloist: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L16.4 3H11.6l-.4 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 2.4h4.8l.4-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1z"/>',
  audio: '<path d="M3 10v4M7 6v12M11 3v18M15 8v8M19 5v14M23 10v4"/>',
  web: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  webhooks: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>',
  overlay: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 20h8"/>',
};

function renderNav() {
  const nav = $("cfgNav");
  nav.innerHTML = "";
  for (const s of SECTIONS) {
    const item = document.createElement("div");
    item.className = "navi" + (s.key === state.section ? " act" : "");
    item.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${NAV_ICON[s.key]}</svg>${s.label}`;
    item.onclick = () => { state.section = s.key; renderNav(); renderPanel(); };
    nav.appendChild(item);
  }
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

function toggleField(label, on, onToggle, hint) {
  const w = document.createElement("div");
  const rowEl = document.createElement("div");
  rowEl.className = "row";
  rowEl.style.justifyContent = "space-between";
  rowEl.innerHTML = `<span class="flabel" style="margin:0">${esc(label)}</span>`;
  const sw = document.createElement("div");
  sw.className = "sw " + (on ? "on" : "off");
  sw.innerHTML = "<i></i>";
  sw.onclick = onToggle;
  rowEl.appendChild(sw);
  w.appendChild(rowEl);
  if (hint) { const h = document.createElement("div"); h.style.cssText = "font-size:12px;color:var(--faint);margin-top:8px"; h.textContent = hint; w.appendChild(h); }
  return w;
}

// Captured set/unset flag for each secret leaf, taken from the last clean GET so
// it survives while the working copy holds a draft string. Path = "section.key".
function captureSecrets() {
  state.secretSet = {};
  for (const [s, k] of [["soloist", "apiKey"], ["webhooks", "secret"], ["web", "password"]]) {
    state.secretSet[`${s}.${k}`] = state.cfg[s][k] === true;
  }
}

// A masked secret shows set/unset + a Replace toggle that swaps in a password input.
// Working copy holds a boolean (untouched) or a string (being replaced).
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

function grid(cols) {
  const g = document.createElement("div");
  g.style.cssText = `display:grid;grid-template-columns:${cols};gap:16px 20px`;
  return g;
}

function renderPanel() {
  const p = $("cfgPanel");
  p.innerHTML = "";
  const c = state.cfg;
  if (state.section === "soloist") {
    const g = grid("1fr 1fr");
    g.append(
      field("Device name", c.soloist.deviceName, (v) => { c.soloist.deviceName = v; markDirty(); }),
      secretRow("Spotify API key", "soloist", "apiKey"),
      field("Soloist WS", c.soloistWs, (v) => { c.soloistWs = v; markDirty(); }),
      field("PipeWire device", c.soloist.pipewireDevice, (v) => { c.soloist.pipewireDevice = v; markDirty(); }, { placeholder: "auto" }),
      toggleField("Autoplay on login", c.autoplay, () => { c.autoplay = !c.autoplay; markDirty(); renderPanel(); }, "Take over the device and start playing once Spotify reports logged in."),
    );
    p.appendChild(g);
    p.appendChild(lockedBlock([
      ["Listen address", c.proxy.listen],
      ["Data dir", c.soloist.dataDir],
      ["Extra args", (c.soloist.extraArgs || []).join(" ") || "—"],
    ]));
  } else if (state.section === "audio") {
    const note = document.createElement("div");
    note.style.cssText = "font-size:12.5px;color:var(--dim);margin-bottom:14px";
    note.textContent = "Fan out soloist-sink to these outputs. Snapcast streams to Snapserver; others are hardware sinks.";
    p.appendChild(note);
    const streamF = field("Snapcast stream name", c.streamName, (v) => { c.streamName = v; markDirty(); });
    streamF.style.cssText = "max-width:460px;margin-bottom:18px";
    p.appendChild(streamF);
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:12px;max-width:460px";
    const selected = new Set(c.audio.outputs);
    for (const sink of state.sinks) {
      const isSnap = sink.name === "snapcast";
      const on = isSnap ? c.audio.snapcast : selected.has(sink.name);
      list.appendChild(toggleField(sink.description, on, () => toggleOutput(sink.name, isSnap)));
    }
    if (!state.sinks.length) list.innerHTML = '<div style="font-size:13px;color:var(--faint)">No sinks reported.</div>';
    p.appendChild(list);
  } else if (state.section === "web") {
    const g = grid("1fr 1fr");
    g.append(
      field("Username", c.web.username, (v) => { c.web.username = v; markDirty(); }),
      secretRow("Password", "web", "password"),
    );
    p.appendChild(g);
    p.appendChild(lockedBlock([
      ["Auth token", c.proxy.token === true ? "set" : "not set"],
      ["Read-only token", c.proxy.readonlyToken === true ? "set" : "not set"],
      ["Session secret", c.web.sessionSecret === true ? "set" : "not set"],
    ], "Managed / autogenerated — edit config.yaml directly"));
  } else if (state.section === "webhooks") {
    const g = grid("1fr 1fr");
    g.append(
      field("Default URL", c.webhooks.defaultUrl, (v) => { c.webhooks.defaultUrl = v; markDirty(); }, { placeholder: "https://…" }),
      field("Delay (ms)", c.webhooks.delayMs, (v) => { c.webhooks.delayMs = Number(v) || 0; markDirty(); }, { type: "number" }),
      secretRow("Shared secret", "webhooks", "secret"),
    );
    p.appendChild(g);
    const label = document.createElement("div");
    label.style.cssText = "margin:22px 0 10px";
    label.innerHTML = '<span class="lbl" style="color:var(--faint)">Per-event overrides</span>';
    p.appendChild(label);
    p.appendChild(urlMapEditor(c.webhooks.urls));
  } else if (state.section === "overlay") {
    p.appendChild(overlayEditor());
  }
}

function lockedBlock(rows, label = "File-only — edit config.yaml directly") {
  const wrap = document.createElement("div");
  const hr = document.createElement("div");
  hr.style.cssText = "margin:22px 0 14px;height:1px;background:var(--line)";
  wrap.appendChild(hr);
  const head = document.createElement("div");
  head.className = "row";
  head.style.cssText = "gap:8px;margin-bottom:14px";
  head.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span class="lbl" style="color:var(--faint)">${esc(label)}</span>`;
  wrap.appendChild(head);
  const g = document.createElement("div");
  g.style.cssText = `display:grid;grid-template-columns:repeat(${Math.min(3, rows.length)},1fr);gap:16px`;
  for (const [k, v] of rows) {
    const d = document.createElement("div");
    d.innerHTML = `<div class="flabel" style="color:var(--faint)">${esc(k)}</div><div style="font-size:14px;color:var(--dim);word-break:break-all">${esc(v)}</div>`;
    g.appendChild(d);
  }
  wrap.appendChild(g);
  return wrap;
}

function urlMapEditor(urls) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;max-width:640px";
  const draw = () => {
    wrap.innerHTML = "";
    for (const key of Object.keys(urls)) {
      const row = document.createElement("div");
      row.className = "row";
      row.style.gap = "10px";
      const k = document.createElement("input");
      k.className = "field"; k.style.maxWidth = "200px"; k.value = key;
      k.onchange = () => { const v = urls[key]; delete urls[key]; if (k.value) urls[k.value] = v; markDirty(); draw(); };
      const v = document.createElement("input");
      v.className = "field"; v.value = urls[key];
      v.oninput = () => { urls[key] = v.value; markDirty(); };
      const del = document.createElement("button");
      del.className = "btn"; del.textContent = "×"; del.title = "Remove";
      del.onclick = () => { delete urls[key]; markDirty(); draw(); };
      row.append(k, v, del);
      wrap.appendChild(row);
    }
    const add = document.createElement("button");
    add.className = "btn"; add.textContent = "+ Add event override";
    add.onclick = () => { let n = "event"; while (urls[n] !== undefined) n += "_"; urls[n] = ""; markDirty(); draw(); };
    wrap.appendChild(add);
  };
  draw();
  return wrap;
}

const OV_FONTS = ["sans-serif", "serif", "monospace", "'Space Grotesk', sans-serif", "'Instrument Sans', sans-serif"];
const OV_EFFECTS = ["fade", "none"];
const OV_ALIGN = ["left", "center", "right"];
const OV_ANCHOR = ["top", "center", "bottom"];

function overlayEditor() {
  const o = state.cfg.overlay;
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:22px";
  const controls = grid("1fr 1fr");
  const sel = (label, val, options, onChange) => {
    const w = document.createElement("div");
    w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
    const s = document.createElement("select");
    s.className = "field";
    for (const opt of options) { const op = document.createElement("option"); op.value = opt; op.textContent = opt; if (opt === val) op.selected = true; s.appendChild(op); }
    s.onchange = () => { onChange(s.value); markDirty(); refreshPreview(); };
    w.appendChild(s);
    return w;
  };
  const num = (label, val, onChange) => field(label, val, (v) => { onChange(Number(v) || 0); markDirty(); refreshPreview(); }, { type: "number" });
  const colour = (label, val, onChange) => {
    const w = document.createElement("div");
    w.innerHTML = `<label class="flabel">${esc(label)}</label>`;
    const inp = document.createElement("input");
    inp.type = "color"; inp.value = val; inp.style.cssText = "width:100%;height:42px;border:1px solid var(--line2);border-radius:10px;background:var(--sub);cursor:pointer";
    inp.oninput = () => { onChange(inp.value); markDirty(); refreshPreview(); };
    w.appendChild(inp);
    return w;
  };
  controls.append(
    sel("Font", o.font, OV_FONTS, (v) => o.font = v),
    num("Font size (px)", o.fontSize, (v) => o.fontSize = v),
    colour("Text colour", o.color, (v) => o.color = v),
    colour("Highlight", o.highlightColor, (v) => o.highlightColor = v),
    sel("Effect", o.effect, OV_EFFECTS, (v) => o.effect = v),
    sel("Alignment", o.alignment, OV_ALIGN, (v) => o.alignment = v),
    sel("Anchor", o.anchor, OV_ANCHOR, (v) => o.anchor = v),
    num("Line count", o.lineCount, (v) => o.lineCount = v),
    num("Timing offset (ms)", o.timingOffsetMs, (v) => o.timingOffsetMs = v),
  );
  const previewCol = document.createElement("div");
  previewCol.innerHTML = '<label class="flabel">Live preview</label>';
  const preview = document.createElement("div");
  preview.id = "ovEditPreview";
  preview.style.cssText = "border-radius:12px;overflow:hidden;background:#111;height:260px;position:relative";
  previewCol.appendChild(preview);
  wrap.append(controls, previewCol);
  setTimeout(refreshPreview, 0);
  return wrap;
}

function refreshPreview() {
  const el = $("ovEditPreview");
  if (el) renderOverlayPreview(el);
  renderMiniOverlay();
}

function markDirty() {
  state.dirty = true;
  $("cfgMsg").textContent = "Unsaved changes";
  $("cfgMsg").style.color = "var(--warn)";
}

async function save() {
  $("cfgSave").disabled = true;
  $("cfgMsg").textContent = "Saving…";
  $("cfgMsg").style.color = "var(--dim)";
  try {
    // Masked secrets are booleans; applyApiConfig ignores non-string secret values,
    // so sending the working copy keeps unchanged secrets and locked fields intact.
    const updated = await api("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.cfg),
    });
    state.cfg = updated;
    captureSecrets();
    state.dirty = false;
    $("cfgMsg").textContent = "Saved";
    $("cfgMsg").style.color = "var(--ok)";
    await refreshSummary();
    renderAll();
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
  $("cfgMsg").textContent = "";
  renderAll();
}

// ---- footer + banner ----
function renderFooter() {
  const s = state.summary;
  $("ftWs").textContent = s.wsUrl || `ws://${s.soloistWs}`;
  const snap = `http://${location.hostname}:1780`;
  const a = $("ftSnapweb");
  a.href = snap; a.textContent = `${location.hostname}:1780 ↗`;
  const sec = $("ftSecrets");
  sec.innerHTML = "";
  const map = [["API", "apiKey"], ["Auth", "authToken"], ["R/O", "readonlyToken"], ["WH secret", "webhooksSecret"]];
  for (const [label, key] of map) {
    const set = !!s.secrets[key];
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.style.cssText = set ? "background:var(--ind-s);color:var(--ind)" : "background:var(--warn-s);color:var(--warn)";
    pill.textContent = `${label} ${set ? "✓" : "—"}`;
    sec.appendChild(pill);
  }
}

function renderBanner() {
  $("banner").classList.toggle("hidden", !state.summary.pendingRestart);
}

async function refreshSummary() {
  state.summary = await api("/api/config-summary");
}

function renderAll() {
  renderNav();
  renderPanel();
  renderOutputs();
  renderWebhooks();
  renderMiniOverlay();
  renderFooter();
  renderBanner();
}

function wireStaticControls() {
  $("btnPlay").onclick = () => sendCommand(pb.playing ? "pause" : "play");
  $("btnNext").onclick = () => sendCommand("next");
  $("btnPrev").onclick = () => sendCommand("previous");
  $("btnShuffle").onclick = () => sendCommand("shuffle");
  $("btnRepeat").onclick = () => sendCommand("repeat");
  $("npBar").onclick = (e) => {
    const dur = pb.track ? pb.track.durationMs : 0;
    if (!dur) return;
    const r = $("npBar").getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    sendCommand("seek", { position_ms: Math.round(dur * pct) });
  };
  $("volBar").onclick = (e) => {
    const r = $("volBar").getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    sendCommand("set_volume", { volume: Math.round(pct * 100) });
  };
  $("qClear").onclick = (e) => { e.preventDefault(); sendCommand("clear_queue"); };
  $("outRefresh").onclick = async () => { await refreshSinks(); renderOutputs(); if (state.section === "audio") renderPanel(); };
  $("ovEdit").onclick = () => { state.section = "overlay"; renderNav(); renderPanel(); $("cfgPanel").scrollIntoView({ behavior: "smooth" }); };
  $("ovCopy").onclick = async () => {
    const url = `${location.origin}/overlay`;
    try { await navigator.clipboard.writeText(url); $("ovCopy").textContent = "Copied!"; setTimeout(() => $("ovCopy").textContent = "Copy URL", 1500); }
    catch { prompt("Overlay URL", url); }
  };
  $("cfgSave").onclick = save;
  $("cfgDiscard").onclick = discard;
  $("restartBtn").onclick = async () => {
    $("restartBtn").disabled = true;
    try { await api("/api/restart-soloist", { method: "POST" }); await refreshSummary(); renderBanner(); }
    finally { $("restartBtn").disabled = false; }
  };
  setInterval(() => { if (pb.track) renderNowPlaying(); }, 500);
}

async function refreshSinks() {
  try { state.sinks = await api("/api/pipewire-sinks"); } catch { state.sinks = []; }
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
  wireStaticControls();
  renderAll();
  renderNowPlaying();
  renderQueue();
  connectWs();
}

if (typeof window !== "undefined" && document.getElementById("cfgPanel")) {
  boot().catch((err) => console.error("landing boot failed", err));
}
