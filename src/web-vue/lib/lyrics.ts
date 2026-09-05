// Lyrics-availability probe for the now-playing/mini-player marker. Ported from the
// overlay engine's lrclib fetch (src/web/overlay.js): same localStorage cache, same
// get→search fallback, same shared-inflight de-dupe. Trimmed to a boolean — the marker
// only needs "does this track have synced lyrics", not the parsed lines (ADR-0014).
import type { Track } from "./wire";

// Value is { syncedLyrics, plainLyrics, cachedAt }; syncedLyrics null = definitive miss
// so we don't re-hit lrclib every play. Keyed by the stable track URI. Only definitive
// API responses are cached; a transient failure returns false WITHOUT caching.
const CACHE_PREFIX = "soloist-lyrics:v2:";
const LRCLIB_CLIENT = "musicparty-soloist (https://github.com/mintopia/musicparty-soloist)";

function cacheGet(key: string): { syncedLyrics: string | null } | undefined {
  try { const v = localStorage.getItem(CACHE_PREFIX + key); return v === null ? undefined : JSON.parse(v); }
  catch { return undefined; }
}
function cacheSet(key: string, obj: unknown): void {
  const json = JSON.stringify(obj);
  try { localStorage.setItem(CACHE_PREFIX + key, json); }
  catch {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      localStorage.setItem(CACHE_PREFIX + key, json);
    } catch {}
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Throws on transient failure (network/5xx) so the caller skips caching; returns null on
// 404 (definitive miss); honours 429 Retry-After.
async function lrclibGet(qs: string): Promise<any> {
  const r = await fetch("https://lrclib.net/api/get?" + qs, { headers: { "Lrclib-Client": LRCLIB_CLIENT } });
  if (r.status === 429) { await wait((Number(r.headers.get("Retry-After")) || 5) * 1000); return lrclibGet(qs); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("lrclib get " + r.status);
  return r.json();
}
async function lrclibSearch(qs: string): Promise<any[]> {
  const r = await fetch("https://lrclib.net/api/search?" + qs, { headers: { "Lrclib-Client": LRCLIB_CLIENT } });
  if (r.status === 429) { await wait((Number(r.headers.get("Retry-After")) || 5) * 1000); return lrclibSearch(qs); }
  if (!r.ok) throw new Error("lrclib search " + r.status);
  return r.json();
}

// Shared per-key so a track change never fires two lrclib round-trips (the mini-player
// and, later, the Lyrics tab can both want the same track right after a change).
const inflight = new Map<string, Promise<boolean>>();

export function trackHasSyncedLyrics(track: Track): Promise<boolean> {
  const key = track.uri || `${track.artist}|${track.title}`.toLowerCase();
  const cached = cacheGet(key);
  if (cached !== undefined) return Promise.resolve(!!cached.syncedLyrics);

  let p = inflight.get(key);
  if (!p) {
    p = fetchUncached(track, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function fetchUncached(track: Track, key: string): Promise<boolean> {
  let synced: string | null = null, plain: string | null = null;
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
    return false; // transient — do NOT cache, so it retries next play
  }
  cacheSet(key, { syncedLyrics: synced, plainLyrics: plain, cachedAt: Date.now() });
  return !!synced;
}
