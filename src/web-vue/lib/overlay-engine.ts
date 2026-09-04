// Typed re-export of the framework-free overlay engine (src/web/overlay.js). ADR-0014
// keeps that engine vanilla; the Lyrics tab reuses its renderer + lrclib fetch/cache
// rather than re-implementing them. Vite bundles the .js; the Vue tsconfig has no
// allowJs, so the import is untyped here and re-typed below (one place, not per caller).
// @ts-expect-error vanilla JS engine bundled by Vite; outside the Vue TS project.
import * as engine from "../../web/overlay.js";

export type LyricLine = { time: number; text: string };
export type OverlayCfg = Record<string, unknown>;

export const mountPreview = engine.mountPreview as (
  container: HTMLElement,
  cfg: OverlayCfg,
  opts?: { refW?: number; checker?: boolean },
) => (lines: LyricLine[], idx: number) => void;

export const currentIndex = engine.currentIndex as (
  lines: { time: number }[],
  timeSec: number,
) => number;

export const fetchSyncedLyrics = engine.fetchSyncedLyrics as (
  track: unknown,
) => Promise<LyricLine[] | null>;
