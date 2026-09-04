<script setup lang="ts">
import { usePlayback } from "../composables/usePlayback";
import { fmtTime } from "../lib/wire";

// Trivial placeholder: proves usePlayback exposes live, reactive playback. The real
// now-playing hero + queue land in T10 (see ADR-0014).
const { state, positionMs, isStale, sendCommand } = usePlayback();
</script>

<template>
  <section class="card view">
    <h1>Now Playing</h1>
    <p class="lbl">Live playback (placeholder — hero + queue land in T10)</p>
    <dl>
      <dt>Connection</dt><dd>{{ state.connected ? "connected" : isStale() ? "stale" : "reconnecting…" }}</dd>
      <dt>Track</dt><dd>{{ state.track ? `${state.track.title} — ${state.track.artist}` : "—" }}</dd>
      <dt>Position</dt>
      <dd>{{ fmtTime(positionMs) }}<span v-if="state.track"> / {{ fmtTime(state.track.durationMs) }}</span></dd>
      <dt>Status</dt><dd>{{ state.playing ? "playing" : "paused" }}</dd>
      <dt>Volume</dt><dd>{{ state.volume ?? "—" }}</dd>
      <dt>Up next</dt><dd>{{ state.queue.length }} track(s)</dd>
    </dl>
    <div class="row">
      <button class="btn" @click="sendCommand('skip_prev')">Prev</button>
      <button class="btn pri" @click="sendCommand(state.playing ? 'pause' : 'play')">
        {{ state.playing ? "Pause" : "Play" }}
      </button>
      <button class="btn" @click="sendCommand('skip_next')">Next</button>
    </div>
  </section>
</template>

<style scoped>
.view { padding: 22px; }
h1 { font-family: var(--disp); font-weight: 700; font-size: 22px; letter-spacing: -.015em; margin: 0 0 4px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 18px 0; font-size: 14px; }
dt { color: var(--dim); font-weight: 600; }
dd { margin: 0; font-family: var(--disp); }
</style>
