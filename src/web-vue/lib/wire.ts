// Soloist wire-format readers + playback-position anchor math. Kept framework-free and
// DOM-free so selftest can import them headless in Node.

export interface Track {
  uri: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  art: string;
}

export interface Playback {
  positionMs: number | null;
  timestampMs: number | null;
  speed: number | null;
  playing?: boolean;
  volume: number | null;
}

export interface Anchor {
  anchorMs: number;
  anchorAt: number;
  speed: number;
}

interface Cover { url?: string; size?: string; }

// cover sizes are small|default|large|xlarge — prefer a mid/large one.
function pickCover(covers: Cover[] | undefined): string {
  if (!Array.isArray(covers) || !covers.length) return "";
  const by: Record<string, string> = {};
  for (const c of covers) if (c && c.url) by[c.size ?? ""] = c.url;
  return by.large || by.default || by.xlarge || by.small || covers[0].url || "";
}

// A Soloist Entity's decorations -> flat track: title = identity.name, artists =
// creators[].entity.identity.name, album = parent.entity.identity.name, art =
// visual_identity.cover[], duration = playback.duration_ms.
export function entityToTrack(item: any): Track | null {
  if (!item || typeof item !== "object") return null;
  const d = item.decorations || {};
  const title: string = d.identity?.name || "";
  const creators: any[] = Array.isArray(d.creators) ? d.creators : [];
  const artist = creators.map((c) => c?.entity?.decorations?.identity?.name).filter(Boolean).join(", ");
  const album: string = d.parent?.entity?.decorations?.identity?.name || "";
  const durationMs = Number(d.playback?.duration_ms) || 0;
  const art = pickCover(d.visual_identity?.cover);
  if (!title && !artist) return null;
  return { uri: item.uri || "", title, artist, album, durationMs, art };
}

// track_changed and playback_state both nest the current track under `item`.
export function readTrack(msg: any): Track | null {
  return msg && msg.item ? entityToTrack(msg.item) : null;
}

// The position anchor rides playback_state + position_sync as
// position = { position_ms sampled at server epoch timestamp_ms, advancing at speed }.
// status (idle|playing|paused|buffering) rides playback_state + playback_changed;
// volume rides playback_state + volume_changed.
export function readPlayback(msg: any): Playback {
  const p = msg?.position;
  const positionMs = p && typeof p.position_ms === "number" ? p.position_ms : null;
  const timestampMs = p && typeof p.timestamp_ms === "number" ? p.timestamp_ms : null;
  const speed = p && typeof p.speed === "number" ? p.speed : null;
  const playing = typeof msg?.status === "string" ? msg.status === "playing" : undefined;
  const volume = typeof msg?.volume === "number" ? msg.volume : null;
  return { positionMs, timestampMs, speed, playing, volume };
}

// queue_changed.upcoming = [{uid, source, item:Entity}] — the up-next list.
export function readQueue(msg: any): Track[] | null {
  const list = msg && msg.upcoming;
  if (!Array.isArray(list)) return null;
  return list.map((e) => entityToTrack(e && e.item) || { uri: "", title: "", artist: "", album: "", durationMs: 0, art: "" });
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Playback anchor: position_ms as of the server epoch anchorAt (timestamp_ms),
// advancing at `speed` (0 = paused). Interpolate against the server clock (Date.now),
// NOT frame-arrival time — a stale sample or replayed snapshot would otherwise read
// as "now" and drift.
export function nowMs(anchor: Anchor): number {
  return anchor.anchorMs + anchor.speed * (Date.now() - anchor.anchorAt);
}

// Apply a readPlayback() result to an anchor: a positioned frame re-anchors verbatim;
// a status-only frame re-anchors at the currently-extrapolated position.
export function applyAnchor(anchor: Anchor, p: Playback): void {
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
