// Typed re-export of the framework-free Soloist wire readers (src/web/frame.js): Vite
// bundles the .js, but the Vue tsconfig has no allowJs, so the import is untyped and
// re-typed here (one place, not per caller). frame.js stays the single source of truth.
// @ts-expect-error vanilla JS module bundled by Vite; outside the Vue TS project.
import * as frame from "../../web/frame.js";

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

export const entityToTrack = frame.entityToTrack as (item: any) => Track | null;
export const readTrack = frame.readTrack as (msg: any) => Track | null;
export const readPlayback = frame.readPlayback as (msg: any) => Playback;
export const readQueue = frame.readQueue as (msg: any) => Track[] | null;
export const fmtTime = frame.fmtTime as (ms: number) => string;
export const nowMs = frame.nowMs as (anchor: Anchor) => number;
export const applyAnchor = frame.applyAnchor as (anchor: Anchor, p: Playback) => void;
