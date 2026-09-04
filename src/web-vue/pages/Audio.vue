<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useConfig } from "../composables/useConfig";

// Synthetic sentinel node.name for the Snapcast toggle (mirrors SNAPCAST_KEY in
// src/pipewire.ts). Real PipeWire nodes never use it.
const SNAPCAST_KEY = "snapcast";
const MAX_DELAY_MS = 5000; // ADR-0013

interface PwSink { name: string; description: string }

// useConfig's Config is deliberately loose (masked passthrough); narrow the slice we
// edit. Same reactive proxy, so mutations still feed the shared dirty computed.
interface AudioCfg {
  audio: { snapcast: boolean; outputs: string[]; outputDelays: Record<string, number> };
  streamName: string;
}

const { config, loaded } = useConfig();
const c = config as unknown as AudioCfg;

const sinks = ref<PwSink[]>([]);

async function refresh() {
  try {
    const res = await fetch("/api/pipewire-sinks", { credentials: "same-origin" });
    sinks.value = res.ok ? await res.json() : [];
  } catch {
    sinks.value = [];
  }
}
onMounted(refresh);

const isSnap = (s: PwSink) => s.name === SNAPCAST_KEY;
const isOn = (s: PwSink) => (isSnap(s) ? c.audio.snapcast : c.audio.outputs.includes(s.name));

function toggle(s: PwSink) {
  if (isSnap(s)) {
    c.audio.snapcast = !c.audio.snapcast;
    return;
  }
  const outs = c.audio.outputs;
  const i = outs.indexOf(s.name);
  if (i >= 0) outs.splice(i, 1);
  else outs.push(s.name);
}

const delayOf = (name: string) => c.audio.outputDelays[name] || 0;
function setDelay(name: string, v: string) {
  c.audio.outputDelays[name] = Math.min(MAX_DELAY_MS, Math.max(0, Math.floor(Number(v) || 0)));
}
</script>

<template>
  <div class="fcol">
  <section class="card view">
    <div class="head">
      <span class="head-title">Audio outputs</span>
      <button class="btn" @click="refresh">Refresh sinks</button>
    </div>

    <div v-if="loaded && sinks.length" class="list">
      <div v-for="s in sinks" :key="s.name" class="out" :class="isOn(s) ? 'on' : 'off'">
        <div class="out-head">
          <div class="tile">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <template v-if="isSnap(s)">
                <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 5v14" />
              </template>
              <template v-else>
                <path d="M11 5 6 9H2v6h4l5 4z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M19 5a9 9 0 0 1 0 14" />
              </template>
            </svg>
          </div>
          <div class="meta">
            <div class="name">{{ s.description }}</div>
            <div class="kind">{{ isSnap(s) ? "Snapcast stream" : "Hardware sink" }}</div>
          </div>
          <div class="sw" :class="isOn(s) ? 'on' : 'off'" @click="toggle(s)"><i></i></div>
        </div>

        <div v-if="isSnap(s) && isOn(s)" class="sub">
          <label class="flabel">Stream name</label>
          <input class="field stream" v-model="c.streamName" />
        </div>
        <div v-else-if="!isSnap(s) && isOn(s)" class="sub">
          <label class="flabel">Delay (ms)</label>
          <input
            class="field delay"
            type="number"
            min="0"
            :max="MAX_DELAY_MS"
            :value="delayOf(s.name)"
            @input="setDelay(s.name, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </div>

    <p v-else-if="loaded" class="empty">No PipeWire sinks reported. Is the audio path up?</p>
    <p v-else class="empty">Loading…</p>
  </section>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.head-title { font-family: var(--disp); font-size: 16px; font-weight: 700; }
.list { display: flex; flex-direction: column; gap: 10px; }

.out { border: 1px solid var(--line); border-radius: 12px; background: var(--sub); overflow: hidden; }
.out.on { border-color: var(--ind); background: var(--ind-s); }

.out-head { display: flex; align-items: center; gap: 14px; padding: 12px 14px; }
.tile {
  width: 38px; height: 38px; border-radius: 9px; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  background: var(--line); color: var(--faint);
}
.out.on .tile { background: var(--ind); color: #fff; }

.meta { flex: 1; min-width: 0; }
.name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dim); }
.out.on .name { color: var(--txt); }
.kind { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); margin-top: 2px; }

.sub { padding: 12px 14px; border-top: 1px solid var(--line); }
.stream { max-width: 360px; width: 100%; }
.delay { max-width: 160px; }

.empty { font-size: 13px; color: var(--faint); padding: 20px 0; text-align: center; }
</style>
