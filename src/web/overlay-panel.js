// Lyrics-tab feature: the Overlay Config editor + its live preview. Exposed as a
// factory so this module never imports app.js (app.js imports this instead) — no
// import cycle. `ctx` supplies the pieces owned by the orchestrator: the shared
// config `state`, `markDirty`/`renderView`, and the playback `pb`/`nowMs`.
import { ovSelect, ovRange, ovNum, ovColour, ovIconGroup, grid } from "./widgets.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  { time: 0, text: "Never gonna give you up" },
  { time: 2, text: "Never gonna let you down" },
  { time: 4, text: "Never gonna run around and desert you" },
  { time: 6, text: "Never gonna make you cry" },
  { time: 8, text: "Never gonna say goodbye" },
];

export function createOverlayPanel({ state, markDirty, renderView, pb, nowMs }) {
  let overlayEngine = null;
  async function loadOverlayEngine() {
    if (!overlayEngine) overlayEngine = await import("/overlay.js");
    return overlayEngine;
  }
  const getOverlayEngine = () => overlayEngine;

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
        ovSelect("Visible lines", o.lineCount, OV_LINES, (v) => { o.lineCount = Number(v); markDirty(); refreshPreview(); }),
        ovNum("Timing offset (ms)", o.timingOffsetMs, (v) => { o.timingOffsetMs = v; markDirty(); refreshPreview(); }),
        ovIconGroup("Alignment", o.alignment, ALIGN_OPTS, (v) => { o.alignment = v; markDirty(); renderView(); }),
        ovIconGroup("Anchor", o.anchor, ANCHOR_OPTS, (v) => { o.anchor = v; markDirty(); renderView(); }),
      );
      return g;
    }
    if (tab === "text") {
      const g = grid("1fr 1fr");
      g.append(
        ovSelect("Font", o.font, OV_FONTS, (v) => { o.font = v; markDirty(); refreshPreview(); }),
        ovNum("Font size (px)", o.fontSize, (v) => { o.fontSize = v; markDirty(); refreshPreview(); }),
        ovColour("Current line", o.color, (v) => { o.color = v; markDirty(); refreshPreview(); }),
        ovColour("Other lines", o.neighbourColor, (v) => { o.neighbourColor = v; markDirty(); refreshPreview(); }),
        ovRange("Other-line opacity", o.dimOpacity, 0, 1, 0.05, (v) => { o.dimOpacity = v; markDirty(); refreshPreview(); }, (v) => v.toFixed(2)),
      );
      return g;
    }
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:18px";
    const g = grid("1fr 1fr");
    g.append(
      ovSelect("Motion", o.motion, OV_MOTION, (v) => { o.motion = v; markDirty(); refreshPreview(); }),
      ovSelect("Easing", o.easing, OV_EASING, (v) => { o.easing = v; markDirty(); refreshPreview(); }),
      ovRange("Transition (ms)", o.transitionMs, 0, 1000, 50, (v) => { o.transitionMs = v; markDirty(); refreshPreview(); }),
    );
    const fg = grid("1fr 1fr");
    fg.style.alignItems = "start";
    const fxStack = document.createElement("div");
    fxStack.style.cssText = "display:flex;flex-direction:column;gap:16px";
    fxStack.append(
      ovRange("Intensity", o.fxIntensity, 0, 100, 1, (v) => { o.fxIntensity = v; markDirty(); refreshPreview(); }),
      ovRange("Speed (ms)", o.fxDurMs, 200, 4000, 100, (v) => { o.fxDurMs = v; markDirty(); refreshPreview(); }),
    );
    fg.append(ovColour("Effect colour", o.fxColor, (v) => { o.fxColor = v; markDirty(); refreshPreview(); }), fxStack);
    wrap.append(g, effectGallery(), fg);
    return wrap;
  }

  function buildOverlay(view) {
    const wrap = document.createElement("div");
    wrap.className = "ovwrap";
    wrap.style.cssText = "display:grid;grid-template-columns:440px 1fr;gap:22px;align-items:start";
    const side = document.createElement("div");
    side.className = "card";
    side.style.cssText = "padding:20px";
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
    // No live lyrics: cycle the sample so the motion style animates. Ping-pong (0..n..0)
    // keeps every step a single line, so the preview glides instead of snapping on wrap.
    const span = PREVIEW_LINES.length - 1;
    const pos = Math.floor(Date.now() / 2000) % (span * 2);
    return { lines: PREVIEW_LINES, idx: pos <= span ? pos : span * 2 - pos };
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

  return { buildOverlay, tickPreview, ensurePreviewLyrics, loadOverlayEngine, getOverlayEngine };
}
