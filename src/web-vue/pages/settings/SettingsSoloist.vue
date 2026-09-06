<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { useConfig } from "../../composables/useConfig";
import SectionCard from "../../components/SectionCard.vue";
import LoadingState from "../../components/LoadingState.vue";
import TextField from "../../components/TextField.vue";
import SecretRow from "../../components/SecretRow.vue";
import ToggleSwitch from "../../components/ToggleSwitch.vue";

const { config, summary, secretSet, loaded } = useConfig();
const c = config as any;

interface PwSink { name: string; description: string }
const sinks = ref<PwSink[]>([]);
const sinksLoading = ref(false);

async function loadSinks() {
  sinksLoading.value = true;
  try {
    const r = await fetch("/api/pipewire-sinks", { credentials: "same-origin" });
    sinks.value = r.ok ? ((await r.json()).sinks ?? []) : [];
  } catch {
    sinks.value = [];
  } finally {
    sinksLoading.value = false;
  }
}

watch(loaded, (ok) => { if (ok && !summary.dockerMode) loadSinks(); }, { immediate: true });

const deviceOptions = computed(() => {
  const opts = sinks.value.map((s) => ({ value: s.name, label: s.description || s.name }));
  const cur = String(c.soloist?.pipewireDevice ?? "");
  if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `${cur} (not detected)` });
  return opts;
});

const pipewireDeviceId = useId();
</script>

<template>
  <LoadingState v-if="!loaded" />
  <SectionCard v-else title="Soloist" subtitle="Identity, credentials, and playback behaviour.">
    <div class="grid2">
      <TextField label="Device name" v-model="c.soloist.deviceName" />
      <div v-if="!summary.dockerMode" class="tf">
        <div class="dev-label">
          <label class="flabel" :for="pipewireDeviceId">PipeWire output device</label>
          <button type="button" class="linkbtn" :disabled="sinksLoading" @click="loadSinks">
            {{ sinksLoading ? "Refreshing…" : "Refresh" }}
          </button>
        </div>
        <select :id="pipewireDeviceId" class="field" v-model="c.soloist.pipewireDevice">
          <option value="">Soloist default (auto)</option>
          <option v-for="o in deviceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <div class="dev-hint">Restart Soloist to apply.</div>
      </div>
      <SecretRow
        label="Spotify API key" section="soloist" field-key="apiKey" revealable
        :is-set="secretSet['soloist.apiKey']" v-model="c.soloist.apiKey"
      />
      <SecretRow
        label="WebSocket auth token" section="proxy" field-key="token" revealable
        :is-set="secretSet['proxy.token']" v-model="c.proxy.token"
        hint="Bearer token external clients use to control Soloist over the WebSocket API. Auto-generated at setup."
      />
    </div>
    <div class="setrow">
      <div class="setrow-txt">
        <div class="setrow-title">Autoplay on login</div>
        <div class="setrow-sub">Start playback automatically once Soloist signs in.</div>
      </div>
      <ToggleSwitch :on="c.autoplay" label="Autoplay on login" @toggle="c.autoplay = !c.autoplay" />
    </div>
  </SectionCard>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px; align-items: start; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
.tf .field { width: 100%; }
.dev-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.linkbtn { background: none; border: none; padding: 0; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--link); }
.linkbtn:disabled { color: var(--faint); cursor: default; }
.dev-hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }
.setrow { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line); }
.setrow-txt { min-width: 0; }
.setrow-title { font-size: 14px; font-weight: 600; }
.setrow-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
</style>
