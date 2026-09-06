// Lyrics Overlay engine. Pure helpers (parseLRC, currentIndex) are importable in
// Node for the selftest; the browser-only bits (renderer, lrclib fetch +
// localStorage cache, WS) run only when the served page boots them.
// The page embeds the Read-only Token + Overlay Config subset server-side
// (window.__SOLOIST_OVERLAY__); this engine never reads the Config File.

import { readTrack, readPlayback, nowMs as anchorNowMs, applyAnchor } from "./frame.js";

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

// localStorage lyrics cache. Value is the lrclib record as a JSON object
// { syncedLyrics, plainLyrics, cachedAt } — syncedLyrics null means a *definitive*
// miss (lrclib has none) so we don't re-hit it every play. Keyed by the stable
// Spotify track URI — NOT artist/title/duration, which drift between frames and
// collide. Only definitive API responses are cached; a transient network / rate-
// limit failure returns null WITHOUT caching, so a blip never poisons a track as
// permanently lyric-less. Bumping the prefix invalidates old-schema entries.
const CACHE_PREFIX = "soloist-lyrics:v2:";
const LRCLIB_CLIENT = "musicparty-soloist (https://github.com/mintopia/musicparty-soloist)";

function cacheGet(key) {
  try { const v = localStorage.getItem(CACHE_PREFIX + key); return v === null ? undefined : JSON.parse(v); }
  catch { return undefined; } // absent, unreadable, or an old-schema value -> refetch
}
function cacheSet(key, obj) {
  const json = JSON.stringify(obj);
  try { localStorage.setItem(CACHE_PREFIX + key, json); }
  catch {
    // quota/blocked: drop our own entries and retry once, then give up.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      localStorage.setItem(CACHE_PREFIX + key, json);
    } catch {}
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Throws on transient failure (network / 5xx) so the caller skips caching; returns
// null on a 404 (definitive "not found for these params"); honours 429 Retry-After.
async function lrclibGet(qs) {
  const r = await fetch("https://lrclib.net/api/get?" + qs, { headers: { "Lrclib-Client": LRCLIB_CLIENT } });
  if (r.status === 429) { await wait((Number(r.headers.get("Retry-After")) || 5) * 1000); return lrclibGet(qs); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("lrclib get " + r.status);
  return r.json();
}
async function lrclibSearch(qs) {
  const r = await fetch("https://lrclib.net/api/search?" + qs, { headers: { "Lrclib-Client": LRCLIB_CLIENT } });
  if (r.status === 429) { await wait((Number(r.headers.get("Retry-After")) || 5) * 1000); return lrclibSearch(qs); }
  if (!r.ok) throw new Error("lrclib search " + r.status);
  return r.json();
}

// Synced lyrics for a track: cache -> lrclib get -> lrclib search fallback. Two
// independent callers (the title-bar marker and the Lyrics-tab preview) can both
// want the same track's lyrics right after a track change; the cache alone doesn't
// stop that race since neither request has completed yet. `inflight` shares the one
// outstanding request per key so a track change never fires two lrclib round-trips.
const inflight = new Map();
export function fetchSyncedLyrics(track) {
  const key = track.uri || `${track.artist}|${track.title}`.toLowerCase();
  const cached = cacheGet(key);
  if (cached !== undefined) return Promise.resolve(cached.syncedLyrics ? parseLRC(cached.syncedLyrics) : null);

  let p = inflight.get(key);
  if (!p) {
    p = fetchSyncedLyricsUncached(track, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function fetchSyncedLyricsUncached(track, key) {
  let synced = null, plain = null;
  try {
    const p = new URLSearchParams({ track_name: track.title, artist_name: track.artist });
    if (track.album) p.set("album_name", track.album);
    if (track.durationMs) p.set("duration", String(Math.round(track.durationMs / 1000)));
    const rec = await lrclibGet(p.toString());
    if (rec && rec.syncedLyrics) {
      synced = rec.syncedLyrics; plain = rec.plainLyrics || null;
    } else {
      const sp = new URLSearchParams({ track_name: track.title });
      if (track.artist) sp.set("artist_name", track.artist);
      const results = await lrclibSearch(sp.toString());
      const hit = (results || []).find((x) => x && x.syncedLyrics);
      if (hit) { synced = hit.syncedLyrics; plain = hit.plainLyrics || null; }
    }
  } catch {
    return null; // transient — do NOT cache, so it retries next play
  }
  cacheSet(key, { syncedLyrics: synced, plainLyrics: plain, cachedAt: Date.now() }); // definitive hit or miss
  return synced ? parseLRC(synced) : null;
}

const OVERLAY_CSS = `
.lyric-viewport{position:relative;width:100%;overflow:hidden;--fade:9%;
  -webkit-mask-image:linear-gradient(to bottom,transparent,#000 var(--fade),#000 calc(100% - var(--fade)),transparent);
  mask-image:linear-gradient(to bottom,transparent,#000 var(--fade),#000 calc(100% - var(--fade)),transparent)}
.lyric-track{position:absolute;left:0;right:0;top:0;will-change:transform}
.lyric-viewport .line{font-family:var(--font);font-size:var(--size);font-weight:800;line-height:1.2;
  color:var(--neighbour);opacity:var(--dim);
  transition:opacity var(--dur) var(--ease),color var(--dur) var(--ease),transform var(--dur) var(--ease);
  text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,1);
  -webkit-text-stroke:1px rgba(0,0,0,.55);paint-order:stroke fill;padding:.1em 0;overflow-wrap:break-word}
.lyric-viewport .line.current{opacity:1;color:var(--current)}
.lyric-viewport .line.pop.current{transform:scale(1.14)}
.lyric-viewport .line.slide.current{animation:sol-lineFocus var(--dur) var(--ease) both}
@keyframes sol-lineFocus{from{opacity:var(--dim)}to{opacity:1}}
.lyric-viewport .line:empty::after{content:"\\00a0"}
.lines-left .line{text-align:left;transform-origin:left center}
.lines-center .line{text-align:center;transform-origin:center}
.lines-right .line{text-align:right;transform-origin:right center}
.fx-glow .line.current{animation:sol-fxGlow var(--fx-dur) ease-in-out infinite}
.fx-rainbow .line.current{color:#ff3b6b;animation:sol-fxHue calc(var(--fx-dur)*3) linear infinite}
.fx-glow .line.slide.current{animation:sol-lineFocus var(--dur) var(--ease) both,sol-fxGlow var(--fx-dur) ease-in-out infinite}
.fx-rainbow .line.slide.current{animation:sol-lineFocus var(--dur) var(--ease) both,sol-fxHue calc(var(--fx-dur)*3) linear infinite}
.fx-shimmer .line.current{position:relative}
.fx-shimmer .line.current::after{content:attr(data-text);position:absolute;left:0;top:.1em;width:100%;
  color:var(--fx-color);-webkit-text-stroke:0;text-shadow:none;pointer-events:none;
  -webkit-mask-image:linear-gradient(105deg,transparent 44%,#000 50%,transparent 56%);
  mask-image:linear-gradient(105deg,transparent 44%,#000 50%,transparent 56%);
  -webkit-mask-size:300% 100%;mask-size:300% 100%;-webkit-mask-position:120% 0;mask-position:120% 0;
  animation:sol-fxShimmer var(--fx-dur) linear infinite}
@keyframes sol-fxGlow{0%,100%{text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 calc(2px + 6px*var(--fx-intensity)) var(--fx-color)}
  50%{text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 calc(8px + 24px*var(--fx-intensity)) var(--fx-color),0 0 calc(16px + 38px*var(--fx-intensity)) var(--fx-color)}}
@keyframes sol-fxHue{to{filter:hue-rotate(360deg)}}
@keyframes sol-fxShimmer{to{-webkit-mask-position:-120% 0;mask-position:-120% 0}}
.sparkle{position:absolute;pointer-events:none;font-size:.62em;z-index:3;color:var(--fx-color);
  text-shadow:0 0 8px currentColor;animation:sol-fxSparkle var(--fx-dur) ease-in-out forwards}
@keyframes sol-fxSparkle{0%{opacity:0;transform:scale(.3) rotate(0deg)}32%{opacity:1}60%{opacity:1}
  100%{opacity:0;transform:scale(1.15) translateY(-1em) rotate(45deg)}}
.fx-wipe .line.current{position:relative}
.fx-wipe .line.current::after{content:attr(data-text);position:absolute;top:.1em;width:fit-content;max-width:100%;
  color:var(--fx-color);-webkit-text-stroke:1px rgba(0,0,0,.55);paint-order:stroke fill;
  text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,1);pointer-events:none;
  -webkit-mask-image:linear-gradient(90deg,#000 50%,transparent 50%);mask-image:linear-gradient(90deg,#000 50%,transparent 50%);
  -webkit-mask-size:200% 100%;mask-size:200% 100%;-webkit-mask-position:100% 0;mask-position:100% 0;
  animation:sol-fxWipe var(--line-dur,3s) linear both}
.lines-left.fx-wipe .line.current::after{left:0}
.lines-center.fx-wipe .line.current::after{left:0;right:0;margin-inline:auto}
.lines-right.fx-wipe .line.current::after{right:0}
@keyframes sol-fxWipe{to{-webkit-mask-position:0% 0;mask-position:0% 0}}
.fx-neon .line.current{animation:sol-fxNeon var(--fx-dur) linear infinite}
.fx-neon .line.slide.current{animation:sol-lineFocus var(--dur) var(--ease) both,sol-fxNeon var(--fx-dur) linear infinite}
@keyframes sol-fxNeon{0%,18%,22%,54%,57%,100%{opacity:1;text-shadow:0 2px 8px rgba(0,0,0,.9),
    0 0 calc(4px + 10px*var(--fx-intensity)) var(--fx-color),0 0 calc(11px + 26px*var(--fx-intensity)) var(--fx-color)}
  20%,55%,56%{opacity:.78;text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 2px var(--fx-color)}}
.fx-glitch .line.current{position:relative;z-index:0}
.fx-glitch .line.current::before,.fx-glitch .line.current::after{content:attr(data-text);position:absolute;left:0;top:.1em;width:100%;z-index:-1;
  -webkit-text-stroke:0;text-shadow:none;pointer-events:none;opacity:calc(.35 + .5*var(--fx-intensity))}
.fx-glitch .line.current::before{color:#ff2d55;animation:sol-fxGlitchR var(--fx-dur) steps(3,end) infinite}
.fx-glitch .line.current::after{color:#00e5ff;animation:sol-fxGlitchC var(--fx-dur) steps(3,end) infinite}
@keyframes sol-fxGlitchR{0%,100%{transform:translate(0,0)}30%{transform:translate(calc(-1px - 3px*var(--fx-intensity)),1px)}60%{transform:translate(calc(-2px*var(--fx-intensity)),-1px)}}
@keyframes sol-fxGlitchC{0%,100%{transform:translate(0,0)}30%{transform:translate(calc(1px + 3px*var(--fx-intensity)),-1px)}60%{transform:translate(calc(2px*var(--fx-intensity)),1px)}}
.fx-pulse .line.current{animation:sol-fxPulse var(--fx-dur) ease-in-out infinite}
.fx-pulse .line.slide.current{animation:sol-lineFocus var(--dur) var(--ease) both,sol-fxPulse var(--fx-dur) ease-in-out infinite}
@keyframes sol-fxPulse{0%,100%{scale:1;text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 calc(2px + 4px*var(--fx-intensity)) var(--fx-color)}
  50%{scale:calc(1 + .05*var(--fx-intensity));text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 calc(9px + 18px*var(--fx-intensity)) var(--fx-color)}}
@media (prefers-reduced-motion:reduce){
  .lyric-viewport .line{transition-property:opacity,color}
  .lyric-viewport .line.slide.current,.fx-glow .line.slide.current,.fx-rainbow .line.slide.current,
  .fx-neon .line.slide.current,.fx-pulse .line.slide.current,
  .fx-glow .line.current,.fx-rainbow .line.current,.fx-neon .line.current,.fx-pulse .line.current{animation:none;scale:1}
  .fx-glow .line.current,.fx-neon .line.current,.fx-pulse .line.current{text-shadow:0 2px 8px rgba(0,0,0,.9),0 0 calc(6px + 14px*var(--fx-intensity)) var(--fx-color)}
  .fx-shimmer .line.current::after{animation:none;opacity:0}
  .fx-wipe .line.current::after{animation:none;-webkit-mask-position:0 0;mask-position:0 0}
  .fx-glitch .line.current::before,.fx-glitch .line.current::after{animation:none;opacity:0}
  .sparkle{display:none}}
`;

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === "undefined") return;
  const s = document.createElement("style");
  s.id = "soloist-overlay-css";
  s.textContent = OVERLAY_CSS;
  document.head.appendChild(s);
  cssInjected = true;
}

const GOOGLE_FONTS = { Inter: "Inter:wght@400;700;800", Roboto: "Roboto:wght@400;700;900", Montserrat: "Montserrat:wght@600;800", "Bebas Neue": "Bebas+Neue" };
const loadedFonts = new Set();
function ensureFont(stack) {
  if (typeof document === "undefined") return;
  for (const fam of Object.keys(GOOGLE_FONTS)) {
    if (stack.includes(fam) && !loadedFonts.has(fam)) {
      loadedFonts.add(fam);
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = `https://fonts.googleapis.com/css2?family=${GOOGLE_FONTS[fam]}&display=swap`;
      document.head.appendChild(l);
    }
  }
}

const prefersReduce = typeof matchMedia !== "undefined" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

function applyStyle(host, cfg) {
  const set = (k, v) => host.style.setProperty(k, v);
  set("--font", cfg.font || "system-ui, sans-serif");
  set("--size", (Number(cfg.fontSize) || 40) + "px");
  set("--current", cfg.color || "#ffffff");
  set("--neighbour", cfg.neighbourColor || cfg.color || "#ffffff");
  set("--dim", String(cfg.dimOpacity ?? 0.35));
  set("--dur", (cfg.motion === "instant" ? 0 : Number(cfg.transitionMs) || 350) + "ms");
  set("--ease", cfg.easing || "ease-out");
  set("--fx-color", cfg.fxColor || "#ffd24a");
  set("--fx-intensity", String((Number(cfg.fxIntensity) || 0) / 100));
  set("--fx-dur", (Number(cfg.fxDurMs) || 1600) + "ms");
}

function anchorCss(anchor) {
  if (anchor === "top") return "top:8%;";
  if (anchor === "center") return "top:50%;transform:translateY(-50%);";
  return "bottom:9%;";
}

// Scrolling-track renderer: all visible lines live in one absolutely-positioned
// track; on advance the whole track glides so the current line stays centred.
// Reuses one element per line index for continuity.
function makeTrackRenderer(container) {
  const track = document.createElement("div");
  track.className = "lyric-track";
  container.appendChild(track);
  let map = new Map();
  let lastCurrent = -1;

  function clear() { map = new Map(); track.replaceChildren(); track.style.transition = ""; track.style.transform = ""; container.style.height = ""; lastCurrent = -1; }

  function render(lines, idx, count, opts) {
    if (idx < 0 || lines.length === 0) { clear(); return; }
    const motion = opts.motion || "slide";
    const effect = opts.effect || "none";
    const durMs = opts.durMs ?? 350;
    const easing = opts.easing || "ease-out";
    const pad = 2;
    const half = Math.floor(count / 2);
    const start = Math.max(0, idx - half - pad);
    const end = Math.min(lines.length - 1, idx + (count - 1 - half) + pad);

    // FLIP reference: where the incoming current line sits before we touch the DOM.
    const reuse = map.get(idx);
    const firstTop = reuse ? reuse.getBoundingClientRect().top : null;

    // Update the DOM in place — drop out-of-window lines, insert only the newly exposed
    // ones at their slot. Never re-append an element that's already positioned: moving a
    // node resets its running CSS transitions, so the colour would snap instead of fading.
    for (const [i, el] of map) if (i < start || i > end) { el.remove(); map.delete(i); }
    for (let i = start; i <= end; i++) {
      let el = map.get(i);
      if (!el) { el = document.createElement("div"); el.textContent = lines[i].text; el.dataset.text = lines[i].text; map.set(i, el); }
      const ref = track.children[i - start];
      if (ref !== el) track.insertBefore(el, ref || null);
    }
    for (let i = start; i <= end; i++) map.get(i).className = "line " + motion + (i === idx ? " current" : "");

    const cur = map.get(idx);
    if (effect === "wipe") {
      const nextT = lines[idx + 1] ? lines[idx + 1].time : lines[idx].time + 4;
      const d = Math.max(600, Math.min((nextT - lines[idx].time) * 1000, 15000));
      cur.style.setProperty("--line-dur", d + "ms");
    }
    const cs = getComputedStyle(cur);
    let lineH = parseFloat(cs.lineHeight); if (!lineH) lineH = parseFloat(cs.fontSize) * 1.2;
    const nominal = lineH + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // Fixed box (one nominal line per visible slot): its height must NOT change with the
    // current window's actual heights, or a center/bottom anchor re-centers instantly on
    // every advance and the block jumps. The track translate below owns all motion.
    const vh = nominal * count;
    container.style.height = Math.round(vh) + "px";
    const tyTarget = Math.round(vh / 2 - (cur.offsetTop + cur.offsetHeight / 2));

    // Glide with a CSS transition committed from an explicit start frame: pin the
    // from-transform, force a reflow, then transition to the target. A WAAPI keyframe
    // animation can paint one frame at the target before it starts — that was the
    // "jumps half a line up" flash — whereas a committed transition never does.
    let snap = motion === "crossfade" || motion === "instant" || durMs <= 0 || firstTop == null || prefersReduce.matches;
    let glided = false;
    track.style.transition = "none";
    track.style.transform = `translateY(${tyTarget}px)`;
    if (!snap) {
      // getBoundingClientRect is post-transform, so in a CSS-scaled stage (the config
      // preview) it reports scaled pixels while the track translate lives in the stage's
      // own unscaled space. Convert the measured delta back by the stage scale, or the
      // FLIP start overshoots and the preview jumps (the full-size overlay is scale 1).
      const rect = cur.getBoundingClientRect();
      const scaleY = cur.offsetHeight ? rect.height / cur.offsetHeight : 1;
      const fromTy = tyTarget + (firstTop - rect.top) / scaleY;
      // Glide a normal advance; snap a big jump (a seek, or lyrics loading mid-song) by how
      // far it travels — not the index delta, since stacked timestamps often skip a line.
      if (Math.abs(fromTy - tyTarget) <= nominal * 3) {
        track.style.transform = `translateY(${fromTy}px)`;
        void track.offsetWidth;
        track.style.transition = `transform ${durMs}ms ${easing}`;
        track.style.transform = `translateY(${tyTarget}px)`;
        glided = true;
      }
    }

    if (effect === "sparkles" && idx !== lastCurrent && !prefersReduce.matches) {
      const burst = () => { if (cur.classList.contains("current")) sparkle(container, cur, opts); };
      if (glided) setTimeout(burst, durMs); else burst();
    }
    lastCurrent = idx;
  }
  return { render, clear };
}

function textRect(lineEl) {
  let r;
  try { const rng = document.createRange(); rng.selectNodeContents(lineEl); r = rng.getBoundingClientRect(); } catch {}
  return r && r.width ? r : lineEl.getBoundingClientRect();
}

function sparkle(container, lineEl, opts) {
  const c = container.getBoundingClientRect(), r = textRect(lineEl);
  // rects are post-transform, but sparkles mount in the container's own unscaled
  // space — convert by the stage scale or a scaled preview double-scales them.
  const scale = lineEl.offsetHeight ? lineEl.getBoundingClientRect().height / lineEl.offsetHeight : 1;
  const intensity = opts?.fxIntensity ?? 0.5;
  const life = opts?.fxDur ?? 1600;
  const n = Math.round(6 + intensity * 26);
  for (let k = 0; k < n; k++) {
    const s = document.createElement("span");
    s.className = "sparkle";
    s.textContent = "✦";
    s.style.left = (r.left - c.left + Math.random() * r.width) / scale + "px";
    s.style.top = (r.top - c.top + Math.random() * r.height) / scale + "px";
    s.style.animationDelay = Math.random() * life * 0.35 + "ms";
    container.appendChild(s);
    setTimeout(() => s.remove(), life * 1.4 + 200);
  }
}

// Mount a full-size overlay into `stage`: CSS vars + anchored viewport + renderer.
// Returns { render(lines, idx), clear }. Used by the overlay page (stage = the page)
// and, scaled, by the Landing Page preview.
export function mountOverlay(stage, cfg) {
  injectCss();
  let cur = cfg;
  if (!stage.style.position) stage.style.position = "relative";
  const wrap = document.createElement("div");
  const viewport = document.createElement("div");
  wrap.appendChild(viewport);
  stage.appendChild(wrap);
  const r = makeTrackRenderer(viewport);
  let last = { lines: [], idx: -1 };

  function applyAll() {
    ensureFont(cur.font || "");
    applyStyle(stage, cur);
    wrap.style.cssText = "position:absolute;left:0;right:0;padding:0 5%;pointer-events:none;" + anchorCss(cur.anchor);
    viewport.className = "lyric-viewport lines-" + (cur.alignment || "center") + " fx-" + (cur.effect || "none");
  }
  applyAll();

  function render(lines, idx) {
    last = { lines, idx };
    const count = Math.max(1, Number(cur.lineCount) || 3);
    const opts = { motion: cur.motion, effect: cur.effect, durMs: Number(cur.transitionMs) || 350, easing: cur.easing, fxIntensity: (Number(cur.fxIntensity) || 0) / 100, fxDur: Number(cur.fxDurMs) || 1600 };
    r.render(lines, idx, count, opts);
  }
  // Apply a new Overlay Config live (font/colour/motion/effect/anchor/lines) and
  // re-render the current window — used when the proxy pushes overlay_config on save.
  function restyle(next) {
    cur = next;
    applyAll();
    r.clear();
    render(last.lines, last.idx);
  }
  return { render, restyle, clear: r.clear };
}

// Landing Page preview: render at a 1080p-ish reference and CSS-scale to fill
// `container` by width — a true-to-life miniature over a transparent checkerboard
// (what OBS composites). Returns render(lines, idx).
export function mountPreview(container, cfg, { refW = 1280, checker = true } = {}) {
  container.style.position = "relative";
  container.style.overflow = "hidden";
  container.innerHTML = "";
  if (checker) {
    container.style.backgroundColor = "#141414";
    container.style.backgroundImage =
      "linear-gradient(45deg,#242424 25%,transparent 25%),linear-gradient(-45deg,#242424 25%,transparent 25%)," +
      "linear-gradient(45deg,transparent 75%,#242424 75%),linear-gradient(-45deg,transparent 75%,#242424 75%)";
    container.style.backgroundSize = "18px 18px";
    container.style.backgroundPosition = "0 0,0 9px,9px -9px,-9px 0";
  } else {
    container.style.backgroundImage = "none";
    container.style.backgroundColor = "#14161f";
  }
  const scale = (container.clientWidth || refW) / refW;
  const stage = document.createElement("div");
  const stageH = (container.clientHeight || 200) / scale;
  stage.style.cssText = `position:absolute;left:0;top:0;width:${refW}px;height:${stageH}px;transform:scale(${scale});transform-origin:top left`;
  container.appendChild(stage);
  return mountOverlay(stage, cfg).render;
}

export function startOverlay(boot) {
  const cfg = boot.overlay || {};
  const root = document.getElementById("overlay") || document.body;
  // Full-viewport positioning context (CSS gives #overlay position:fixed;inset:0).
  // Must NOT be `relative` — a relative root collapses to zero height, so the
  // absolutely-positioned, bottom/center-anchored lyric block renders at the top.
  root.style.position = "fixed";
  const overlay = mountOverlay(root, cfg);
  const render = overlay.render;
  let offsetSec = (Number(cfg.timingOffsetMs) || 0) / 1000;

  let lines = [];
  let track = null;
  let fetchSeq = 0;
  // Position anchor: position_ms as of server epoch anchorAt (timestamp_ms), advancing
  // at `speed` (0 = paused) — see frame.js for the interpolation rationale.
  const anchor = { anchorMs: 0, anchorAt: 0, speed: 0 };
  const nowMs = () => anchorNowMs(anchor);

  async function onTrack(next) {
    const same = track && (next.uri ? next.uri === track.uri : next.title === track.title && next.artist === track.artist);
    if (same) return;
    track = next;
    lines = [];
    render(lines, -1);
    const seq = ++fetchSeq;
    const fetched = await fetchSyncedLyrics(track);
    if (seq === fetchSeq) lines = fetched || [];
  }

  function onFrame(msg) {
    if (msg.type === "overlay_config" && msg.overlay) {
      offsetSec = (Number(msg.overlay.timingOffsetMs) || 0) / 1000;
      overlay.restyle(msg.overlay);
      return;
    }
    const t = readTrack(msg);
    if (t) void onTrack(t);
    const pb = readPlayback(msg);
    applyAnchor(anchor, pb);
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let backoffMs = 1000;
  const BACKOFF_MAX_MS = 15000;
  function connect() {
    const ws = new WebSocket(`${proto}//${location.host}/?token=${encodeURIComponent(boot.token || "")}`);
    ws.onopen = () => { backoffMs = 1000; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === "object" && !Array.isArray(msg)) onFrame(msg);
    };
    ws.onclose = () => {
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    };
    ws.onerror = () => ws.close();
  }
  connect();

  let lastIdx = -2, lastLines = null;
  function tick() {
    const idx = currentIndex(lines, nowMs() / 1000 + offsetSec);
    if (idx !== lastIdx || lines !== lastLines) { lastIdx = idx; lastLines = lines; render(lines, idx); }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

if (typeof window !== "undefined" && window.__SOLOIST_OVERLAY__) {
  startOverlay(window.__SOLOIST_OVERLAY__);
}
