// Soloist wire-format readers + playback-position anchor math. The vanilla Lyrics
// Overlay (overlay.js) imports these directly; the Vue app carries a typed port in
// src/web-vue/lib/wire.ts. selftest imports this module headless (ADR-0014 seam) —
// the framework-free source of truth for the Soloist frame shape (proxy.ts STATE_EVENTS).

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

// queue_changed.upcoming = [{uid, source, item:Entity}] — the up-next list.
export function readQueue(msg) {
  const list = msg && msg.upcoming;
  if (!Array.isArray(list)) return null;
  return list.map((e) => entityToTrack(e && e.item) || { uri: "", title: "", artist: "", album: "", durationMs: 0, art: "" });
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
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

// Playback anchor: position_ms as of the server epoch anchorAt (timestamp_ms),
// advancing at `speed` (0 = paused). Interpolate against the server clock (Date.now),
// NOT frame-arrival time — a sync sampled seconds ago, or a stale snapshot replayed on
// reconnect, would otherwise read as "now", so lyrics/position drift and worsen as the
// anchor ages.
export function nowMs(anchor) {
  return anchor.anchorMs + anchor.speed * (Date.now() - anchor.anchorAt);
}

// Apply a readPlayback() result to an anchor {anchorMs,anchorAt,speed}: a positioned
// frame re-anchors verbatim (trusting its sample time and speed); a status-only frame
// (e.g. playback_changed) re-anchors at the currently-extrapolated position.
export function applyAnchor(anchor, p) {
  if (p.positionMs !== null) {
    anchor.anchorMs = p.positionMs;
    anchor.anchorAt = p.timestampMs ?? Date.now();
    if (p.speed !== null) anchor.speed = p.speed;
  } else if (typeof p.playing === "boolean") {
    anchor.anchorMs = nowMs(anchor);
    anchor.anchorAt = Date.now();
    anchor.speed = p.playing ? 1 : 0;
  }
}
