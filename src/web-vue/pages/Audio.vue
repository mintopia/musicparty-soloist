<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useConfig } from "../composables/useConfig";
import ToggleSwitch from "../components/ToggleSwitch.vue";
import SectionCard from "../components/SectionCard.vue";
import LoadingState from "../components/LoadingState.vue";
import { PhBroadcast, PhSpeakerHifi } from "@phosphor-icons/vue";

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
const sinksLoaded = ref(false);
const refreshedAt = ref(0);
const refreshing = ref(false);

async function refresh(force = false) {
  refreshing.value = true;
  try {
    const res = await fetch(force ? "/api/pipewire-sinks?refresh=1" : "/api/pipewire-sinks", { credentials: "same-origin" });
    const data = res.ok ? await res.json() : { sinks: [], refreshedAt: 0 };
    sinks.value = data.sinks ?? [];
    refreshedAt.value = data.refreshedAt ?? 0;
  } catch {
    sinks.value = [];
  } finally {
    sinksLoaded.value = true;
    refreshing.value = false;
  }
}
onMounted(() => refresh());

const refreshedLabel = computed(() =>
  refreshedAt.value ? `Updated ${new Date(refreshedAt.value).toLocaleTimeString()}` : "",
);

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
  <div>
  <SectionCard title="Audio Outputs" subtitle="Route Soloist's stream to Snapcast or a hardware sink.">
    <template #action>
      <span v-if="refreshedLabel" class="stamp">{{ refreshedLabel }}</span>
      <button type="button" class="btn" :disabled="refreshing" @click="refresh(true)">
        {{ refreshing ? "Refreshing…" : "Refresh sinks" }}
      </button>
    </template>

    <div v-if="loaded && sinks.length" class="list">
      <div v-for="s in sinks" :key="s.name" class="out" :class="isOn(s) ? 'on' : 'off'">
        <div class="out-head">
          <div class="tile">
            <PhBroadcast v-if="isSnap(s)" :size="19" weight="fill" />
            <PhSpeakerHifi v-else :size="19" weight="fill" />
          </div>
          <div class="meta">
            <div class="name">{{ s.description }}</div>
            <div class="kind">{{ isSnap(s) ? "Snapcast stream" : "Hardware sink" }}</div>
          </div>
          <ToggleSwitch :on="isOn(s)" :label="`${s.description} output`" @toggle="toggle(s)" />
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

    <p v-else-if="loaded && sinksLoaded" class="empty">No PipeWire sinks reported. Is the audio path up?</p>
    <LoadingState v-else />
  </SectionCard>
  </div>
</template>

<style scoped>
.stamp { font-size: 12px; color: var(--faint); white-space: nowrap; }
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
