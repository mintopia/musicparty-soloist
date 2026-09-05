<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { usePlayback } from "../composables/usePlayback";
import { trackHasSyncedLyrics } from "../lib/lyrics";
import Marquee from "./Marquee.vue";
import { PhMicrophoneStage, PhSkipBack, PhPlay, PhPause, PhSkipForward, PhSpeakerSimpleHigh, PhSpeakerSimpleX } from "@phosphor-icons/vue";

// Top-bar mini-player. Ported from the #miniPlayer half of renderNowPlaying + wireStatic
// (src/web/app.js): art/title/artist, play/prev/next, a volume popover, and the synced-
// lyrics marker. Shown only when a track is present; dims when the anchor is stale.
const { state, positionMs, isStale, sendCommand } = usePlayback();

const track = computed(() => state.track);
const stale = computed(() => isStale());
const dur = computed(() => track.value?.durationMs ?? 0);
const progPct = computed(() =>
  dur.value ? Math.min(100, Math.max(0, (Math.min(positionMs.value, dur.value) / dur.value) * 100)) : 0);
const muted = computed(() => state.volume === 0);

// Lyrics marker: keyed by track identity so it fires once per change (not on every
// same-track frame, which re-creates the track object). Ignores a resolution that lands
// after the track has already moved on.
const trackKey = computed(() => {
  const t = track.value;
  return t ? t.uri || `${t.artist}|${t.title}` : null;
});
const hasLyrics = ref(false);
watch(trackKey, (key) => {
  hasLyrics.value = false;
  const t = state.track;
  if (!key || !t) return;
  trackHasSyncedLyrics(t).then((ok) => {
    if (trackKey.value === key) hasLyrics.value = ok;
  }).catch(() => { /* transient — leave marker off */ });
}, { immediate: true });

// Volume popover. Fixed-positioned (the player is overflow:hidden for the progress bar),
// so its coordinates are set from the button rect on open. The slider syncs from live
// state only while closed, so a server echo never fights the user's drag.
const volOpen = ref(false);
const volPos = ref({ top: "0px", right: "0px" });
const localVol = ref(50);
watch(() => state.volume, (v) => { if (!volOpen.value && v !== null) localVol.value = Math.round(v); }, { immediate: true });

function toggleVol(e: MouseEvent) {
  e.stopPropagation();
  volOpen.value = !volOpen.value;
  if (volOpen.value) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    volPos.value = { top: `${r.bottom + 8}px`, right: `${window.innerWidth - r.right}px` };
  }
}
function onVolInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  localVol.value = v;
  sendCommand("set_volume", { volume: v });
}
function onDocClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".mpvol")) volOpen.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocClick));
</script>

<template>
  <div v-if="track" class="miniPlayer" :class="{ stale }">
    <div class="mpArt" :style="track.art ? { backgroundImage: `url('${encodeURI(track.art)}')` } : {}"></div>
    <div class="mpmeta">
      <Marquee class="mpTitle" :text="track.title || 'Untitled'" />
      <div class="mpArtist">{{ track.artist || "—" }}</div>
    </div>
    <div v-if="hasLyrics" class="mpLyrics" title="Synced lyrics available for this track">
      <PhMicrophoneStage :size="14" weight="fill" />
    </div>
    <div class="mpctl">
      <button class="mpb" title="Previous" aria-label="Previous track" @click="sendCommand('skip_prev')">
        <PhSkipBack :size="15" weight="fill" />
      </button>
      <button class="mpb mpplay" title="Play/Pause" :aria-label="state.playing ? 'Pause' : 'Play'" @click="sendCommand(state.playing ? 'pause' : 'play')">
        <PhPause v-if="state.playing" :size="16" weight="fill" />
        <PhPlay v-else :size="16" weight="fill" />
      </button>
      <button class="mpb" title="Next" aria-label="Next track" @click="sendCommand('skip_next')">
        <PhSkipForward :size="15" weight="fill" />
      </button>
      <div class="mpvol">
        <button class="mpb" title="Volume" :aria-label="muted ? 'Unmute' : 'Volume'" @click="toggleVol">
          <PhSpeakerSimpleX v-if="muted" :size="15" weight="fill" />
          <PhSpeakerSimpleHigh v-else :size="15" weight="fill" />
        </button>
        <div v-show="volOpen" class="mpVolPop" :style="volPos">
          <PhSpeakerSimpleHigh :size="15" weight="fill" />
          <input class="mpVolRange" type="range" min="0" max="100" step="1" :value="localVol" @input="onVolInput" />
          <span class="mpVolVal">{{ localVol }}</span>
        </div>
      </div>
    </div>
    <div class="mpProg" :style="{ width: `${progPct}%` }"></div>
  </div>
</template>

<style scoped>
.miniPlayer {
  position: relative; overflow: hidden; display: flex; align-items: center; gap: 10px;
  padding: 5px 10px 5px 6px; background: var(--sub); border: 1px solid var(--line); border-radius: 14px; min-width: 0;
}
.miniPlayer.stale { opacity: .55; }
.mpProg { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--ind); border-radius: 0 2px 2px 0; transition: width .25s linear; }
.mpArt { width: 34px; height: 34px; border-radius: 8px; background-size: cover; background-position: center; background-color: var(--line); flex: 0 0 auto; }
.mpmeta { min-width: 0; max-width: 150px; }
.mpTitle { font-size: 13px; font-weight: 600; }
.mpArtist { font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mpLyrics { flex: 0 0 auto; width: 24px; height: 24px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: var(--ind); background: var(--ind-s); }
.mpctl { display: flex; align-items: center; gap: 4px; }
.mpb { width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line2); background: var(--card); color: var(--txt); cursor: pointer; }
.mpb:hover { border-color: var(--ind); color: var(--ind); }
.mpplay { background: var(--ind); color: #fff; border-color: var(--ind); }
.mpplay:hover { background: var(--ind-h); color: #fff; }
.mpvol { position: relative; }
.mpVolPop { position: fixed; z-index: 50; display: flex; padding: 12px 14px; background: var(--card); border: 1px solid var(--line2); border-radius: 12px; box-shadow: var(--sh2); align-items: center; gap: 10px; }
.mpVolRange { width: 120px; accent-color: var(--ind); }
.mpVolVal { font-size: 12px; color: var(--dim); min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; }

@media (max-width: 860px) {
  .miniPlayer { display: none !important; }
}
</style>
