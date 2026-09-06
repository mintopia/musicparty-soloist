<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, nextTick } from "vue";
import { useConfig } from "../composables/useConfig";
import { usePlayback } from "../composables/usePlayback";
import { mountPreview, currentIndex, fetchSyncedLyrics, type LyricLine } from "../lib/overlay-engine";
import OvColour from "../components/OvColour.vue";
import LoadingState from "../components/LoadingState.vue";
import { PhTextAlignLeft, PhTextAlignCenter, PhTextAlignRight, PhAlignTop, PhAlignCenterHorizontal, PhAlignBottom, PhArrowUpRight } from "@phosphor-icons/vue";

// Mirrors config.ts OverlayConfig (camelCase, as the /api/config passthrough serves it).
interface OverlayCfg {
  font: string; fontSize: number; color: string; neighbourColor: string; dimOpacity: number;
  motion: string; easing: string; transitionMs: number; effect: string; fxColor: string;
  fxIntensity: number; fxDurMs: number; alignment: string; anchor: string; lineCount: number; timingOffsetMs: number;
}

const { config } = useConfig();
const { state, positionMs } = usePlayback();

// The shared reactive config is populated async by load(); overlay is absent until then.
// A computed keeps `o` bound to the live proxy so mutations flag dirty once it arrives.
const o = computed(() => (config as unknown as { overlay?: OverlayCfg }).overlay);

const OV_FONTS: [string, string][] = [
  ["System", "system-ui, sans-serif"],
  ["Inter", "'Inter', sans-serif"],
  ["Roboto", "'Roboto', sans-serif"],
  ["Montserrat", "'Montserrat', sans-serif"],
  ["Bebas Neue", "'Bebas Neue', sans-serif"],
  ["Mono", "ui-monospace, monospace"],
];
const OV_EASING: [string, string][] = [
  ["Settle", "cubic-bezier(.16,1,.3,1)"],
  ["Ease", "ease"],
  ["Ease out", "ease-out"],
  ["Ease in-out", "ease-in-out"],
  ["Linear", "linear"],
  ["Overshoot", "cubic-bezier(.34,1.56,.64,1)"],
];
const OV_MOTION: [string, string][] = [["Slide + fade", "slide"], ["Crossfade", "crossfade"], ["Pop", "pop"], ["Instant", "instant"]];
const OV_EFFECTS = ["none", "glow", "shimmer", "rainbow", "sparkles", "wipe", "neon", "glitch", "pulse"];
const OV_LINES = ["1", "3", "5"];
const ALIGN_OPTS = [
  { value: "left", title: "Left", icon: PhTextAlignLeft },
  { value: "center", title: "Center", icon: PhTextAlignCenter },
  { value: "right", title: "Right", icon: PhTextAlignRight },
];
const ANCHOR_OPTS = [
  { value: "top", title: "Top", icon: PhAlignTop },
  { value: "center", title: "Center", icon: PhAlignCenterHorizontal },
  { value: "bottom", title: "Bottom", icon: PhAlignBottom },
];
type OvTab = "layout" | "text" | "motion";
const TABS: [OvTab, string][] = [["layout", "Layout"], ["text", "Text"], ["motion", "Motion & FX"]];

const PREVIEW_LINES: LyricLine[] = [
  { time: 0, text: "Never gonna give you up" },
  { time: 2, text: "Never gonna let you down" },
  { time: 4, text: "Never gonna run around and desert you" },
  { time: 6, text: "Never gonna make you cry" },
  { time: 8, text: "Never gonna say goodbye" },
];

const ovTab = ref<OvTab>("layout");
const overlayUrl = `${location.origin}/overlay`;
const copyLabel = ref("Copy URL");

type Status = "checking" | "available" | "none" | "notrack" | "idle";
const previewLyrics = reactive<{ uri: string | null; lines: LyricLine[]; status: Status }>({ uri: null, lines: [], status: "idle" });
const STATUS_TEXT: Record<Status, string> = {
  checking: "Checking lyrics…",
  available: "Lyrics available",
  none: "No synced lyrics for this track",
  notrack: "No track playing — showing sample",
  idle: "Checking lyrics…",
};

const previewEl = ref<HTMLElement>();
let previewRender: ((lines: LyricLine[], idx: number) => void) | null = null;
let pvLastIdx = -2;
let pvLastLines: LyricLine[] | null = null;

// Current track's real synced lyrics at the live playback position when available;
// otherwise a ping-pong sample so the motion style still animates.
function previewFrame(): { lines: LyricLine[]; idx: number } {
  if (previewLyrics.lines.length) {
    const off = (Number(o.value?.timingOffsetMs) || 0) / 1000;
    return { lines: previewLyrics.lines, idx: currentIndex(previewLyrics.lines, positionMs.value / 1000 + off) };
  }
  const span = PREVIEW_LINES.length - 1;
  const pos = Math.floor(Date.now() / 2000) % (span * 2);
  return { lines: PREVIEW_LINES, idx: pos <= span ? pos : span * 2 - pos };
}

// The vanilla engine takes a loose Record; bridge the typed OverlayCfg once (callers guard).
const cfgRecord = () => o.value as unknown as Record<string, unknown>;

function remountPreview() {
  if (!previewEl.value || !o.value) return;
  previewRender = mountPreview(previewEl.value, cfgRecord());
  const { lines, idx } = previewFrame();
  previewRender(lines, idx);
  pvLastIdx = idx; pvLastLines = lines;
}

// Advance the mounted preview to the current line — no re-mount, so it scrolls live.
function tickPreview() {
  if (!previewRender) return;
  const { lines, idx } = previewFrame();
  if (idx === pvLastIdx && lines === pvLastLines) return;
  pvLastIdx = idx; pvLastLines = lines;
  previewRender(lines, idx);
}

const galleryStages = reactive<Record<string, HTMLElement | null>>({});
function setGalleryStage(eff: string, el: unknown) { galleryStages[eff] = (el as HTMLElement) || null; }

function remountGallery() {
  if (!o.value) return;
  for (const eff of OV_EFFECTS) {
    const stage = galleryStages[eff];
    if (!stage) continue;
    const tcfg = { ...cfgRecord(), effect: eff, anchor: "center", lineCount: 1, fontSize: 46, motion: "instant" };
    mountPreview(stage, tcfg, { checker: false, refW: 360 })([{ time: 0, text: "Abc" }], 0);
  }
}

async function ensurePreviewLyrics() {
  const t = state.track;
  if (!t) { previewLyrics.uri = null; previewLyrics.lines = []; previewLyrics.status = "notrack"; remountPreview(); return; }
  const key = t.uri || `${t.artist}|${t.title}`;
  if (previewLyrics.uri === key && previewLyrics.status !== "idle") return;
  previewLyrics.uri = key; previewLyrics.lines = []; previewLyrics.status = "checking";
  let lines: LyricLine[] | null = null;
  try { lines = await fetchSyncedLyrics(t); } catch { lines = null; }
  const now = state.track && (state.track.uri || `${state.track.artist}|${state.track.title}`);
  if (now !== key) return; // track changed mid-fetch
  previewLyrics.lines = lines || [];
  previewLyrics.status = lines && lines.length ? "available" : "none";
  remountPreview();
}

async function copyUrl() {
  try { await navigator.clipboard.writeText(overlayUrl); } catch { /* clipboard blocked */ }
  copyLabel.value = "Copied!";
  setTimeout(() => (copyLabel.value = "Copy URL"), 1500);
}
const openUrl = () => window.open(overlayUrl, "_blank");

watch(o, () => { remountPreview(); nextTick(remountGallery); }, { deep: true });
watch(ovTab, () => nextTick(remountGallery));
watch(() => state.track, ensurePreviewLyrics, { immediate: true });

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  nextTick(() => { remountPreview(); remountGallery(); });
  timer = setInterval(tickPreview, 500);
});
onUnmounted(() => { if (timer) clearInterval(timer); });

const numInput = (e: Event) => Number((e.target as HTMLInputElement).value) || 0;
</script>

<template>
  <div class="ovwrap">
    <div class="card side">
      <div class="head">
        <div class="head-title">Overlay</div>
        <div class="pill" :class="previewLyrics.status">
          <span class="dot"></span>{{ STATUS_TEXT[previewLyrics.status] }}
        </div>
      </div>

      <div class="seg tabs">
        <button v-for="[k, label] in TABS" :key="k" type="button" :class="{ on: ovTab === k }" @click="ovTab = k">{{ label }}</button>
      </div>

      <template v-if="o">
      <div v-if="ovTab === 'layout'" class="grid2">
        <div>
          <label class="flabel">Visible lines</label>
          <select class="field" :value="String(o.lineCount)" @change="o.lineCount = Number(($event.target as HTMLSelectElement).value)">
            <option v-for="n in OV_LINES" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <div>
          <label class="flabel">Timing offset (ms)</label>
          <input class="field" type="number" :value="o.timingOffsetMs" @input="o.timingOffsetMs = numInput($event)" />
        </div>
        <div>
          <label class="flabel">Alignment</label>
          <div class="seg">
            <button v-for="opt in ALIGN_OPTS" :key="opt.value" type="button" :title="opt.title" :aria-label="opt.title" :class="{ on: o.alignment === opt.value }" @click="o.alignment = opt.value">
              <component :is="opt.icon" :size="19" weight="bold" />
            </button>
          </div>
        </div>
        <div>
          <label class="flabel">Anchor</label>
          <div class="seg">
            <button v-for="opt in ANCHOR_OPTS" :key="opt.value" type="button" :title="opt.title" :aria-label="opt.title" :class="{ on: o.anchor === opt.value }" @click="o.anchor = opt.value">
              <component :is="opt.icon" :size="19" weight="bold" />
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="ovTab === 'text'" class="grid2">
        <div>
          <label class="flabel">Font</label>
          <select class="field" v-model="o.font">
            <option v-for="[text, value] in OV_FONTS" :key="value" :value="value">{{ text }}</option>
          </select>
        </div>
        <div>
          <label class="flabel">Font size (px)</label>
          <input class="field" type="number" :value="o.fontSize" @input="o.fontSize = numInput($event)" />
        </div>
        <OvColour label="Current line" v-model="o.color" />
        <OvColour label="Other lines" v-model="o.neighbourColor" />
        <div>
          <label class="flabel">Other-line opacity: <span class="ovval">{{ o.dimOpacity.toFixed(2) }}</span></label>
          <input type="range" class="rng" min="0" max="1" step="0.05" :value="o.dimOpacity" @input="o.dimOpacity = numInput($event)" />
        </div>
      </div>

      <div v-else class="motion">
        <div class="grid2">
          <div>
            <label class="flabel">Motion</label>
            <select class="field" v-model="o.motion">
              <option v-for="[text, value] in OV_MOTION" :key="value" :value="value">{{ text }}</option>
            </select>
          </div>
          <div>
            <label class="flabel">Easing</label>
            <select class="field" v-model="o.easing">
              <option v-for="[text, value] in OV_EASING" :key="value" :value="value">{{ text }}</option>
            </select>
          </div>
          <div>
            <label class="flabel">Transition (ms): <span class="ovval">{{ o.transitionMs }}</span></label>
            <input type="range" class="rng" min="0" max="1000" step="50" :value="o.transitionMs" @input="o.transitionMs = numInput($event)" />
          </div>
        </div>

        <div>
          <label class="flabel">Effect (current line)</label>
          <div class="gallery">
            <button v-for="eff in OV_EFFECTS" :key="eff" type="button" class="tile" :class="{ on: o.effect === eff }" @click="o.effect = eff">
              <div class="stage" :ref="(el) => setGalleryStage(eff, el)"></div>
              <div class="cap">{{ eff }}</div>
            </button>
          </div>
        </div>

        <div class="grid2 fg">
          <OvColour label="Effect colour" v-model="o.fxColor" />
          <div class="fxstack">
            <div>
              <label class="flabel">Intensity: <span class="ovval">{{ o.fxIntensity }}</span></label>
              <input type="range" class="rng" min="0" max="100" step="1" :value="o.fxIntensity" @input="o.fxIntensity = numInput($event)" />
            </div>
            <div>
              <label class="flabel">Speed (ms): <span class="ovval">{{ o.fxDurMs }}</span></label>
              <input type="range" class="rng" min="200" max="4000" step="100" :value="o.fxDurMs" @input="o.fxDurMs = numInput($event)" />
            </div>
          </div>
        </div>
      </div>
      </template>
      <LoadingState v-else />

      <div class="obs">
        <div class="flabel obs-lbl">OBS browser source URL</div>
        <input class="field ro url" readonly :value="overlayUrl" />
        <div class="row btns">
          <button class="btn" @click="copyUrl">{{ copyLabel }}</button>
          <button class="btn" @click="openUrl">Open <PhArrowUpRight :size="16" weight="fill" /></button>
        </div>
      </div>
    </div>

    <div ref="previewEl" class="preview"></div>
  </div>
</template>

<style scoped>
.ovwrap { display: grid; grid-template-columns: 440px 1fr; gap: 22px; align-items: start; }
.side { padding: 20px; }

.head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.head-title { font-family: var(--disp); font-size: 16px; font-weight: 700; }

.pill { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; border-radius: 20px; padding: 4px 11px; background: var(--sub); color: var(--dim); }
.pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.available { background: var(--ok-s); color: var(--ok); }
.pill.none { background: var(--warn-s); color: var(--warn); }

.seg { display: flex; background: var(--sub); border: 1px solid var(--line2); border-radius: 11px; padding: 3px; gap: 2px; }
.seg button { flex: 1; display: flex; align-items: center; justify-content: center; font-family: var(--sans); font-size: 13px; font-weight: 600; padding: 8px; border: none; border-radius: 8px; cursor: pointer; background: transparent; color: var(--dim); }
.seg button.on { background: var(--card); color: var(--ind); box-shadow: var(--sh); }
.tabs { border-radius: 11px; margin-bottom: 20px; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.field { width: 100%; }
.rng { width: 100%; accent-color: var(--ind); }
.ovval { color: var(--ind); }

.motion { display: flex; flex-direction: column; gap: 18px; }
.fg { align-items: start; }
.fxstack { display: flex; flex-direction: column; gap: 16px; }

.gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
/* Dark tile behind the miniature; mirrors the engine's no-checker stage bg (overlay.js). */
.tile { --tile-bg: #14161f; padding: 0; border: 1px solid var(--line2); border-radius: 10px; overflow: hidden; cursor: pointer; background: var(--tile-bg); }
.tile.on { border-color: var(--ind); box-shadow: 0 0 0 2px var(--ind-s); }
.tile .stage { height: 48px; position: relative; pointer-events: none; }
.tile .cap { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); padding: 4px 0; text-align: center; background: var(--sub); }
.tile.on .cap { color: var(--ind); }

.obs { margin-top: 20px; padding: 16px; background: var(--sub); border: 1px solid var(--line); border-radius: 12px; }
.obs-lbl { margin: 0 0 8px; }
.url { font-size: 12.5px; background: var(--card); }
.btns { gap: 8px; margin-top: 10px; }
.btns .btn { flex: 1; }

.preview { border-radius: 14px; overflow: hidden; width: 100%; aspect-ratio: 16 / 9; max-height: 72vh; border: 1px solid var(--line); }

@media (max-width: 860px) {
  .ovwrap { grid-template-columns: 1fr; }
}
</style>
