<script setup lang="ts">
import { computed } from "vue";
import { useConfig } from "../composables/useConfig";
import SecretRow from "../components/SecretRow.vue";
import SectionCard from "../components/SectionCard.vue";

// Soloist state events that fire webhooks (proxy.ts STATE_EVENTS), ordered by usefulness.
const WEBHOOK_EVENTS = [
  "track_changed", "playback_changed", "volume_changed", "queue_changed", "options_changed",
  "context_changed", "device_changed", "playback_state", "auth_state", "position_sync",
];

const { config, secretSet, loaded } = useConfig();

const webhooks = computed(() => config.webhooks as {
  defaultUrl: string; delayMs: number; urls: Record<string, string>; secret: string | boolean;
});

// Editing the reactive config auto-marks dirty via useConfig's `dirty` computed.
const delayMs = computed({
  get: () => webhooks.value.delayMs,
  set: (v) => { webhooks.value.delayMs = Number(v) || 0; },
});

const overrideKeys = computed(() => Object.keys(webhooks.value.urls));

// Options for a row's type select: the row's own type plus every event not already
// mapped (so a type can never be duplicated). An unknown legacy key stays selectable.
function optionsFor(key: string): string[] {
  const urls = webhooks.value.urls;
  const known = WEBHOOK_EVENTS.filter((e) => e === key || !(e in urls));
  return WEBHOOK_EVENTS.includes(key) ? known : [key, ...known];
}

function retype(oldKey: string, newKey: string) {
  const urls = webhooks.value.urls;
  if (newKey === oldKey || newKey in urls) return;
  urls[newKey] = urls[oldKey];
  delete urls[oldKey];
}

function removeOverride(key: string) {
  delete webhooks.value.urls[key];
}

const nextEvent = computed(() => WEBHOOK_EVENTS.find((e) => !(e in webhooks.value.urls)));
function addOverride() {
  if (nextEvent.value) webhooks.value.urls[nextEvent.value] = "";
}
</script>

<template>
  <div class="col">
    <SectionCard title="Webhooks" subtitle="Fire an HTTP request to an external service on Soloist state events.">
      <p v-if="!loaded || !config.webhooks" class="lbl">Loading…</p>
      <template v-else>
        <div class="top">
          <div class="grow">
            <label class="flabel">Default URL</label>
            <input class="field" v-model="webhooks.defaultUrl" placeholder="https://…" />
          </div>
          <div class="delay">
            <label class="flabel">Min interval (ms)</label>
            <input class="field" type="number" v-model="delayMs" />
          </div>
        </div>

        <SecretRow
          class="secret"
          label="Authorization Header"
          :is-set="secretSet['webhooks.secret']"
          v-model="webhooks.secret"
        />

        <div class="ov-label"><span class="lbl">Per-event overrides</span></div>
        <div class="ov">
          <div v-for="key in overrideKeys" :key="key" class="row ov-row">
            <select class="field sel" :value="key"
              @change="retype(key, ($event.target as HTMLSelectElement).value)">
              <option v-for="ev in optionsFor(key)" :key="ev" :value="ev">{{ ev }}</option>
            </select>
            <input class="field grow" v-model="webhooks.urls[key]" placeholder="https://…" />
            <button class="btn" title="Remove" @click="removeOverride(key)">×</button>
          </div>
          <button class="btn" :disabled="!nextEvent" @click="addOverride">+ Add event override</button>
          <div v-if="!nextEvent" class="dev-hint">Every event already has an override.</div>
        </div>
      </template>
    </SectionCard>
  </div>
</template>

<style scoped>
.col { display: flex; flex-direction: column; gap: 20px; }
.top { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.grow { flex: 1; }
.delay { flex: 0 0 auto; width: 120px; }
.field { width: 100%; }
.secret { max-width: 340px; }
.ov-label { margin: 22px 0 10px; }
.ov { display: flex; flex-direction: column; gap: 10px; max-width: 700px; }
.ov-row { gap: 10px; }
.sel { max-width: 210px; flex: 0 0 auto; }
.dev-hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }
</style>
