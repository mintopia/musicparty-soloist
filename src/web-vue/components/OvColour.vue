<script setup lang="ts">
import { computed } from "vue";

// Value is emitted as hex. Slider edits round-trip through integer HSL — a slight,
// expected quantisation; a native-picker hex is stored verbatim.
defineProps<{ label: string }>();
const hex = defineModel<string>({ required: true });

function hexToHsl(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) { hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; hue = (hue * 60 + 360) % 360; }
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [Math.round(hue), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(hue: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

const hsl = computed(() => hexToHsl(hex.value || "#ffffff"));
const h = computed(() => hsl.value[0]);
const s = computed(() => hsl.value[1]);
const l = computed(() => hsl.value[2]);

const hueTrack = "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)";
const satTrack = computed(() => `linear-gradient(to right,hsl(${h.value},0%,${l.value}%),hsl(${h.value},100%,${l.value}%))`);
const litTrack = computed(() => `linear-gradient(to right,hsl(${h.value},${s.value}%,0%),hsl(${h.value},${s.value}%,50%),hsl(${h.value},${s.value}%,100%))`);

const setH = (v: string) => { hex.value = hslToHex(Number(v), s.value, l.value); };
const setS = (v: string) => { hex.value = hslToHex(h.value, Number(v), l.value); };
const setL = (v: string) => { hex.value = hslToHex(h.value, s.value, Number(v)); };
</script>

<template>
  <div>
    <label class="flabel">{{ label }}</label>
    <div class="row">
      <button type="button" class="swatch" title="Pick colour" :style="{ background: hex }">
        <input type="color" class="picker" :value="hex" @input="hex = ($event.target as HTMLInputElement).value" />
      </button>
      <div class="sliders">
        <input type="range" class="hsl" min="0" max="360" step="1" :value="h" :aria-label="`${label} hue`" :style="{ background: hueTrack }" @input="setH(($event.target as HTMLInputElement).value)" />
        <input type="range" class="hsl" min="0" max="100" step="1" :value="s" :aria-label="`${label} saturation`" :style="{ background: satTrack }" @input="setS(($event.target as HTMLInputElement).value)" />
        <input type="range" class="hsl" min="0" max="100" step="1" :value="l" :aria-label="`${label} lightness`" :style="{ background: litTrack }" @input="setL(($event.target as HTMLInputElement).value)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 12px; align-items: center; }
.swatch { position: relative; width: 42px; height: 42px; flex: 0 0 auto; border-radius: 10px; border: 1px solid var(--line2); cursor: pointer; padding: 0; }
.picker { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.sliders { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.hsl { width: 100%; height: 12px; -webkit-appearance: none; appearance: none; border-radius: 6px; cursor: pointer; }
.hsl::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 1px solid rgba(0,0,0,.4); box-shadow: 0 1px 3px rgba(0,0,0,.4); cursor: pointer; }
.hsl::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 1px solid rgba(0,0,0,.4); cursor: pointer; }
</style>
