// Lyrics Overlay engine. Pure helpers (parseLRC, currentIndex, escapeHtml) are
// importable in Node for the selftest; the browser-only bits (renderer, lrclib
// fetch + localStorage cache, WS) run only when the served page boots them.
// The page embeds the Read-only Token + Overlay Config subset server-side
// (window.__SOLOIST_OVERLAY__); this engine never reads the Config File.

// [mm:ss.xx] synced-lyric lines -> sorted [{time, text}] (seconds). Metadata
// tags ([ar:], [ti:], ...) carry no numeric timestamp and are dropped. A line
// may carry several timestamps; each becomes its own entry. Blank entries are
// kept so instrumental gaps clear the display.
export function parseLRC(text) {
  const out = [];
  const tag = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const line of String(text).split(/\r?\n/)) {
    tag.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = tag.exec(line)) !== null) {
      stamps.push(Number(m[1]) * 60 + Number(m[2]));
    }
    if (stamps.length === 0) continue;
    const lyric = line.replace(tag, "").trim();
    for (const time of stamps) out.push({ time, text: lyric });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Index of the active line at timeSec = last line whose time <= timeSec, else -1.
export function currentIndex(lines, timeSec) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= timeSec) idx = i;
    else break;
  }
  return idx;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- browser-only below ---

// Pull the current-track identity out of a Soloist state frame. Soloist's exact
// schema isn't pinned here, so read the plausible shapes defensively; a frame we
// can't read leaves the last track in place.
function readTrack(msg) {
  const t = (msg && typeof msg.track === "object" && msg.track) || msg || {};
  const title = t.name || t.title || msg.name || msg.title || "";
  let artist = "";
  const artists = t.artists || msg.artists;
  if (Array.isArray(artists)) artist = artists.map((a) => (typeof a === "string" ? a : a && a.name) || "").filter(Boolean).join(", ");
  else artist = t.artist || msg.artist || (typeof artists === "string" ? artists : "");
  const album = (t.album && (t.album.name || t.album)) || msg.album || "";
  const durationMs = Number(t.duration_ms ?? t.duration ?? msg.duration_ms ?? msg.duration ?? 0) || 0;
  if (!title && !artist) return null;
  return { title, artist, album: typeof album === "string" ? album : "", durationMs };
}

function readPlayback(msg) {
  const positionMs = Number(msg.position_ms ?? msg.position ?? msg.progress_ms ?? NaN);
  let playing;
  if (typeof msg.playing === "boolean") playing = msg.playing;
  else if (typeof msg.is_playing === "boolean") playing = msg.is_playing;
  else if (typeof msg.paused === "boolean") playing = !msg.paused;
  return { positionMs: Number.isNaN(positionMs) ? null : positionMs, playing };
}

const LRCLIB = "https://lrclib.net/api/get";
const CACHE_PREFIX = "soloist-lyrics:";

function cacheKey(track) {
  return CACHE_PREFIX + [track.artist, track.title, Math.round(track.durationMs / 1000)].join("|").toLowerCase();
}

// Fetch synced lyrics for a track from lrclib, cached in localStorage (misses
// cached too, so a track without lyrics is not refetched every play).
export async function fetchSyncedLyrics(track) {
  const key = cacheKey(track);
  try {
    const hit = localStorage.getItem(key);
    if (hit !== null) return hit === "" ? null : parseLRC(hit);
  } catch { /* localStorage unavailable — fetch each time */ }

  const params = new URLSearchParams({ artist_name: track.artist, track_name: track.title });
  if (track.album) params.set("album_name", track.album);
  if (track.durationMs) params.set("duration", String(Math.round(track.durationMs / 1000)));

  let synced = "";
  try {
    const res = await fetch(`${LRCLIB}?${params.toString()}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = await res.json();
      synced = (body && body.syncedLyrics) || "";
    }
  } catch { /* network/CORS failure — treat as no lyrics */ }

  try { localStorage.setItem(key, synced); } catch { /* ignore */ }
  return synced ? parseLRC(synced) : null;
}

const ANCHOR_CSS = { top: "top:8%;bottom:auto", center: "top:50%;transform:translateY(-50%)", bottom: "top:auto;bottom:9%" };

// Build the overlay DOM from Overlay Config and return render(lines, idx).
export function makeRenderer(root, cfg) {
  const font = cfg.font || "sans-serif";
  const color = cfg.color || "#ffffff";
  const highlight = cfg.highlightColor || color;
  const fontSize = Number(cfg.fontSize) || 48;
  const align = cfg.alignment || "center";
  const lineCount = Math.max(1, Number(cfg.lineCount) || 3);
  const fade = (cfg.effect || "fade") !== "none";

  const stack = document.createElement("div");
  stack.style.cssText =
    `position:absolute;left:0;right:0;${ANCHOR_CSS[cfg.anchor] || ANCHOR_CSS.bottom};` +
    `text-align:${align};padding:0 6vw;font-family:${font};pointer-events:none`;
  root.appendChild(stack);

  const side = Math.floor((lineCount - 1) / 2);

  return function render(lines, idx) {
    stack.textContent = "";
    if (idx < 0 || lines.length === 0) return;
    for (let i = idx - side; i <= idx + side; i++) {
      if (i < 0 || i >= lines.length) continue;
      const active = i === idx;
      const el = document.createElement("div");
      const size = active ? fontSize : Math.round(fontSize * 0.5);
      el.style.cssText =
        `font-weight:700;line-height:1.15;letter-spacing:-.01em;margin:8px 0;` +
        `font-size:${size}px;color:${color};` +
        (fade ? "animation:soloist-fade .35s ease;" : "") +
        (active
          ? `text-shadow:0 0 24px ${highlight}99, 0 3px 12px rgba(0,0,0,.7);-webkit-text-stroke:1px rgba(0,0,0,.25);opacity:1`
          : `opacity:.34;text-shadow:0 2px 10px rgba(0,0,0,.6)`);
      el.innerHTML = escapeHtml(lines[i].text);
      stack.appendChild(el);
    }
  };
}

function makeChip(root) {
  const chip = document.createElement("div");
  chip.style.cssText =
    "position:absolute;left:30px;bottom:120px;display:none;gap:11px;align-items:center;" +
    "background:rgba(10,10,14,.42);backdrop-filter:blur(8px);border:1px solid #ffffff22;" +
    "border-radius:12px;padding:9px 13px;font-family:'Instrument Sans',system-ui,sans-serif";
  const art = document.createElement("div");
  art.style.cssText = "width:34px;height:34px;border-radius:7px;background:linear-gradient(135deg,#2dd4bf,#06b6d4);flex:0 0 auto";
  const meta = document.createElement("div");
  const title = document.createElement("div");
  title.style.cssText = "color:#fff;font-weight:700;font-size:14px";
  const artist = document.createElement("div");
  artist.style.cssText = "color:#ffffffaa;font-size:12px";
  meta.append(title, artist);
  chip.append(art, meta);
  root.appendChild(chip);
  return function update(track) {
    if (!track) { chip.style.display = "none"; return; }
    title.textContent = track.title;
    artist.textContent = track.artist;
    chip.style.display = "flex";
  };
}

// Browser entry: connect read-only, follow the current track, fetch its synced
// lyrics, and drive the renderer off the extrapolated playback position.
export function startOverlay(boot) {
  const cfg = boot.overlay || {};
  const root = document.getElementById("overlay") || document.body;
  const render = makeRenderer(root, cfg);
  const updateChip = makeChip(root);
  const offsetSec = (Number(cfg.timingOffsetMs) || 0) / 1000;

  let lines = [];
  let track = null;
  let posMs = 0; // last known position
  let posAt = 0; // performance.now() when posMs was set
  let playing = false;
  let fetchSeq = 0;

  function nowMs() {
    return playing ? posMs + (performance.now() - posAt) : posMs;
  }

  async function onTrack(next) {
    if (track && next.title === track.title && next.artist === track.artist) return;
    track = next;
    updateChip(track);
    lines = [];
    render(lines, -1);
    const seq = ++fetchSeq;
    const fetched = await fetchSyncedLyrics(track);
    if (seq === fetchSeq) lines = fetched || [];
  }

  function onFrame(msg) {
    const t = readTrack(msg);
    if (t) void onTrack(t);
    const pb = readPlayback(msg);
    if (pb.positionMs !== null) { posMs = pb.positionMs; posAt = performance.now(); }
    if (typeof pb.playing === "boolean") {
      if (pb.playing && !playing) posAt = performance.now();
      else if (!pb.playing && playing) posMs = nowMs();
      playing = pb.playing;
    }
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  function connect() {
    const ws = new WebSocket(`${proto}//${location.host}/?token=${encodeURIComponent(boot.token || "")}`);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === "object" && !Array.isArray(msg)) onFrame(msg);
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }
  connect();

  // The tick runs every frame; only touch the DOM when the active line or the
  // lyric set actually changed.
  let lastIdx = -2;
  let lastLines = null;
  function tick() {
    const idx = currentIndex(lines, nowMs() / 1000 + offsetSec);
    if (idx !== lastIdx || lines !== lastLines) {
      lastIdx = idx;
      lastLines = lines;
      render(lines, idx);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

if (typeof window !== "undefined" && window.__SOLOIST_OVERLAY__) {
  startOverlay(window.__SOLOIST_OVERLAY__);
}
