<script setup lang="ts">
import { computed } from "vue";
import { usePlayback } from "../composables/usePlayback";
import { fmtTime } from "../lib/wire";
import Marquee from "../components/Marquee.vue";
import { PhShuffle, PhSkipBack, PhPlay, PhPause, PhSkipForward, PhRepeat, PhRepeatOnce, PhSpeakerSimpleHigh, PhVinylRecord } from "@phosphor-icons/vue";

// Now-playing hero + up-next queue, driven live by usePlayback (control WS). Ported from
// buildNow/renderNowPlaying/renderQueue in src/web/app.js — every control sends the same
// command as the vanilla UI; the hero is a dark card in both themes by design (ADR-0014).
const { state, positionMs, isStale, sendCommand } = usePlayback();

const stale = computed(() => isStale());
const track = computed(() => state.track);
const dur = computed(() => track.value?.durationMs ?? 0);
// positionMs already collapses to the frozen anchor while stale (see usePlayback tick).
const pos = computed(() => Math.min(positionMs.value, dur.value || Infinity));
const pct = computed(() => (dur.value ? Math.min(100, (pos.value / dur.value) * 100) : 0));
const vol = computed(() => (state.volume === null ? 0 : Math.max(0, Math.min(100, state.volume))));
const statusText = computed(() => (track.value ? (state.playing ? "Now playing" : "Paused") : "Idle"));

const artStyle = computed(() =>
  track.value?.art ? { backgroundImage: `url("${encodeURI(track.value.art)}")` } : {});

function seek(e: MouseEvent) {
  if (!dur.value) return;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  sendCommand("seek", { position_ms: Math.round(dur.value * frac) });
}
function setVolume(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  sendCommand("set_volume", { volume: Math.round(frac * 100) });
}
function cycleRepeat() {
  const next = state.repeat === "off" ? "context" : state.repeat === "context" ? "track" : "off";
  if (next === "context") sendCommand("set_repeat_context", { enabled: true });
  else if (next === "track") sendCommand("set_repeat_track", { enabled: true });
  else { sendCommand("set_repeat_context", { enabled: false }); sendCommand("set_repeat_track", { enabled: false }); }
}
const repeatTitle = computed(() =>
  state.repeat === "track" ? "Repeat: one" : state.repeat === "context" ? "Repeat: all" : "Repeat: off");
</script>

<template>
  <div class="now">
    <!-- now-playing hero -->
    <div class="hero">
      <div class="bloom bloom-a"></div>
      <div class="bloom bloom-b"></div>
      <div class="hero-inner">
        <div class="row art-row">
          <div class="art" :class="{ stale }" :style="artStyle"></div>
          <div class="meta">
            <div class="row status-row">
              <span class="dot" :class="{ live: track && state.playing }"></span>
              <span class="status">{{ statusText }}</span>
            </div>
            <Marquee class="title" :text="track ? track.title || 'Untitled' : 'Nothing playing'" />
            <div class="artist">{{ track ? [track.artist, track.album].filter(Boolean).join(" — ") || "—" : "—" }}</div>
            <div class="row chips">
              <span v-if="track && track.album" class="hchip"><PhVinylRecord :size="16" weight="fill" />{{ track.album }}</span>
            </div>
          </div>
        </div>

        <div class="prog-wrap">
          <div class="bar" :class="{ stale }" @click="seek">
            <div class="fill" :style="{ inset: `0 ${100 - pct}% 0 0` }"></div>
            <div class="handle" :style="{ left: `${pct}%` }"></div>
          </div>
          <div class="row times">
            <span>{{ fmtTime(pos) }}</span>
            <span>{{ fmtTime(dur) }}</span>
          </div>
        </div>

        <div class="row transport-row">
          <div class="row transport">
            <button class="hbtn" :class="{ act: state.shuffle }" title="Shuffle" aria-label="Shuffle"
              @click="sendCommand('set_shuffle', { enabled: !state.shuffle })">
              <PhShuffle :size="16" weight="fill" />
            </button>
            <button class="hbtn" title="Previous" aria-label="Previous track" @click="sendCommand('skip_prev')">
              <PhSkipBack :size="17" weight="fill" />
            </button>
            <button class="hplay" title="Play/Pause" :aria-label="state.playing ? 'Pause' : 'Play'" @click="sendCommand(state.playing ? 'pause' : 'play')">
              <PhPause v-if="state.playing" :size="22" weight="fill" />
              <PhPlay v-else :size="22" weight="fill" />
            </button>
            <button class="hbtn" title="Next" aria-label="Next track" @click="sendCommand('skip_next')">
              <PhSkipForward :size="17" weight="fill" />
            </button>
            <button class="hbtn repeat" :class="{ act: state.repeat !== 'off' }" :title="repeatTitle" :aria-label="repeatTitle" @click="cycleRepeat">
              <PhRepeatOnce v-if="state.repeat === 'track'" :size="16" weight="fill" />
              <PhRepeat v-else :size="16" weight="fill" />
            </button>
          </div>
          <div class="row vol">
            <PhSpeakerSimpleHigh :size="18" weight="fill" />
            <div class="vol-bar" @click="setVolume">
              <div class="fill" :style="{ inset: `0 ${100 - vol}% 0 0` }"></div>
              <div class="handle" :style="{ left: `${vol}%` }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- up next / queue -->
    <div class="queue">
      <div class="bloom bloom-q"></div>
      <div class="row qhead">
        <span class="status">Up next</span>
        <span class="qcount">{{ state.queue.length }}</span>
      </div>
      <div class="qlist">
        <div v-if="!state.queue.length" class="qempty">Queue is empty.</div>
        <div v-for="(t, i) in state.queue" :key="i" class="row qrow">
          <div class="qart" :style="t.art ? { backgroundImage: `url('${encodeURI(t.art)}')` } : {}"></div>
          <div class="qmeta">
            <div class="qtitle">{{ t.title }}</div>
            <div class="qartist">{{ t.artist }}</div>
          </div>
          <span class="qdur">{{ t.durationMs ? fmtTime(t.durationMs) : "" }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The hero + queue are dark glass surfaces in both themes (DESIGN.md). Palette lives in
   local vars here — the global light/dark tokens don't apply to these two cards. */
.now {
  --h-fg: #fff; --h-fg2: rgba(255,255,255,.72); --h-fg3: rgba(255,255,255,.6);
  --h-fg4: rgba(255,255,255,.55); --h-track: rgba(255,255,255,.16); --h-hair: rgba(255,255,255,.10);
  --h-teal: #5eead4; --h-cyan: #22d3ee; --h-teal-d: #14b8a6; --h-cyan-d: #06b6d4;
  --h-mint: #2dd4bf; --h-green: #34d399;
  display: flex; flex-direction: column; gap: 18px; max-width: 720px; margin: 0 auto;
}
.bloom { position: absolute; width: 440px; height: 440px; border-radius: 50%; pointer-events: none; }
.bloom-a { left: -130px; top: -210px; background: radial-gradient(circle, rgba(20,184,166,.42), transparent 64%); }
.bloom-b { right: -150px; bottom: -230px; background: radial-gradient(circle, rgba(6,182,212,.30), transparent 64%); }
.bloom-q { width: 300px; height: 300px; right: -120px; top: -120px; background: radial-gradient(circle, rgba(6,182,212,.22), transparent 65%); }

.hero {
  position: relative; border-radius: 20px; overflow: hidden;
  background: linear-gradient(135deg, #191a2b 0%, #241a36 55%, #2c1830 100%);
  border: 1px solid var(--h-hair); box-shadow: 0 22px 54px rgba(26,18,56,.30);
}
.hero-inner { position: relative; padding: 26px 28px; }
.art-row { gap: 24px; align-items: center; }
.art {
  width: 120px; height: 120px; border-radius: 16px; flex: 0 0 auto;
  background: linear-gradient(135deg, var(--h-teal), var(--h-cyan) 55%, var(--h-teal-d));
  background-size: cover; background-position: center; box-shadow: 0 16px 36px rgba(0,0,0,.45);
}
.meta { flex: 1; min-width: 0; }
.status-row { gap: 8px; }
.dot { background: #6b6b72; }
.dot.live { background: var(--h-green); box-shadow: 0 0 8px var(--h-green); }
.status { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--h-fg3); }
.title {
  font-family: var(--disp); font-size: 30px; font-weight: 700; letter-spacing: -.02em;
  color: var(--h-fg); margin-top: 8px;
}
.artist { color: var(--h-fg2); font-size: 15px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chips { gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.hchip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--h-fg2); background: rgba(255,255,255,.10); border-radius: 20px; padding: 4px 11px; }

.prog-wrap { margin-top: 24px; }
.bar { height: 5px; border-radius: 4px; background: var(--h-track); position: relative; cursor: pointer; }
.bar .fill { position: absolute; inset: 0 100% 0 0; background: linear-gradient(90deg, var(--h-teal-d), var(--h-mint)); border-radius: 4px; }
.bar .handle { position: absolute; left: 0; top: -4px; width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.4); }
.times { justify-content: space-between; margin-top: 9px; }
.times span { font-size: 12px; color: var(--h-fg4); font-variant-numeric: tabular-nums; }

.transport-row { justify-content: space-between; margin-top: 18px; }
.transport { gap: 12px; }
.hbtn {
  width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--h-fg2); cursor: pointer;
}
.hbtn:hover { background: rgba(255,255,255,.18); color: var(--h-fg); }
.hbtn.act { color: var(--h-teal); }
.hplay {
  width: 58px; height: 58px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  border: none; cursor: pointer; color: #06231f;
  background: linear-gradient(135deg, var(--h-teal), var(--h-mint)); box-shadow: 0 10px 26px rgba(20,184,166,.4);
}
.hplay:hover { filter: brightness(1.05); }
.vol { gap: 11px; color: var(--h-fg2); }
.vol-bar { width: 96px; height: 6px; border-radius: 4px; background: var(--h-track); position: relative; cursor: pointer; margin-right: 2px; }
.vol-bar .fill { position: absolute; inset: 0 100% 0 0; background: linear-gradient(90deg, var(--h-teal-d), var(--h-cyan-d)); border-radius: 4px; }
.vol-bar .handle { position: absolute; left: 0; top: -3px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); }

.stale { opacity: .55; }

.queue {
  border-radius: 20px; overflow: hidden; position: relative;
  background: linear-gradient(180deg, #1c1d2e, #241a33); border: 1px solid var(--h-hair);
  box-shadow: 0 22px 54px rgba(26,18,56,.26); display: flex; flex-direction: column;
}
.qhead { justify-content: flex-start; gap: 9px; padding: 18px 20px 10px; position: relative; }
.qcount { font-size: 11px; font-weight: 700; color: #0b3b36; background: var(--h-teal); border-radius: 20px; padding: 2px 9px; }
.qlist { position: relative; flex: 1; overflow: auto; padding: 0 10px 12px; display: flex; flex-direction: column; gap: 1px; max-height: 520px; }
.qempty { padding: 16px 12px; font-size: 13px; color: rgba(255,255,255,.4); }
.qrow { gap: 12px; padding: 7px 10px; }
.qart { width: 38px; height: 38px; border-radius: 8px; flex: 0 0 auto; background: linear-gradient(135deg, var(--h-teal), var(--h-cyan)); background-size: cover; background-position: center; }
.qmeta { flex: 1; min-width: 0; }
.qtitle { font-size: 13.5px; font-weight: 600; color: var(--h-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qartist { font-size: 12px; color: rgba(255,255,255,.62); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qdur { font-size: 11.5px; color: rgba(255,255,255,.52); font-variant-numeric: tabular-nums; }

/* Dark theme: swap the hero/queue from warm plum to a cold deep-ocean gradient so they sit
   in the same cold family as the rest of the dark UI. Light theme keeps the plum. */
:root[data-theme="dark"] .hero {
  background: linear-gradient(140deg, #0c1a2c 0%, #0b2233 54%, #0a2531 100%);
  box-shadow: 0 22px 54px rgba(4, 18, 30, .5);
}
:root[data-theme="dark"] .queue {
  background: linear-gradient(180deg, #0c1a29, #0b212f);
  box-shadow: 0 22px 54px rgba(4, 18, 30, .42);
}
</style>
