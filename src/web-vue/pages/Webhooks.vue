<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useConfig } from "../composables/useConfig";
import SecretRow from "../components/SecretRow.vue";

// Soloist state events that fire webhooks (proxy.ts STATE_EVENTS), ordered by usefulness.
const WEBHOOK_EVENTS = [
  "track_changed", "playback_changed", "volume_changed", "queue_changed", "options_changed",
  "context_changed", "device_changed", "playback_state", "auth_state", "position_sync",
];

interface WebhookStat { lastStatus: number | null; ok: number; fail: number; lastError: string | null; }
interface WebhooksView {
  config: { defaultUrl: string; urls: Record<string, string>; hasSecret: boolean };
  stats: Record<string, WebhookStat>;
}

const { config, secretSet, loaded } = useConfig();

// Delivery stats: a snapshot of the saved server view, fetched once (mirrors the legacy
// view — reflects saved config, not unsaved edits).
const wh = ref<WebhooksView | null>(null);
onMounted(async () => {
  try {
    const res = await fetch("/api/webhooks", { credentials: "same-origin" });
    if (res.ok) wh.value = await res.json();
  } catch { /* leave delivery card empty */ }
});

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

const deliveries = computed(() => {
  const w = wh.value;
  if (!w) return [];
  const out: { name: string; url: string; stat: WebhookStat | undefined }[] = [];
  if (w.config.defaultUrl) out.push({ name: "default", url: w.config.defaultUrl, stat: w.stats[w.config.defaultUrl] });
  for (const [k, url] of Object.entries(w.config.urls || {})) out.push({ name: k, url, stat: w.stats[url] });
  return out;
});

function statBad(s: WebhookStat): boolean {
  return s.fail > 0 && (s.lastStatus === null || s.lastStatus >= 400);
}
function statLabel(s: WebhookStat): string {
  return `${s.lastStatus ?? "err"} · ${s.ok}✓${s.fail ? " " + s.fail + "✗" : ""}`;
}
</script>

<template>
  <div class="col">
    <section class="card view">
      <h1>Webhooks</h1>
      <p v-if="!loaded || !config.webhooks" class="lbl">Loading…</p>
      <template v-else>
        <div class="top">
          <div class="grow">
            <label class="flabel">Default URL</label>
            <input class="field" v-model="webhooks.defaultUrl" placeholder="https://…" />
          </div>
          <div class="delay">
            <label class="flabel">Delay (ms)</label>
            <input class="field" type="number" v-model="delayMs" />
          </div>
        </div>

        <SecretRow
          class="secret"
          label="Shared secret"
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
        </div>
      </template>
    </section>

    <section class="card view" v-if="wh">
      <h1>Delivery</h1>
      <p v-if="!deliveries.length" class="empty">No webhooks configured.</p>
      <template v-else>
        <div v-for="(d, i) in deliveries" :key="d.name">
          <div v-if="i > 0" class="hr"></div>
          <div class="row dest">
            <div class="dest-info">
              <div class="dest-name">{{ d.name }}</div>
              <div class="dest-url">{{ d.url }}</div>
            </div>
            <span v-if="!d.stat" class="pill none">no deliveries</span>
            <span v-else class="pill" :class="statBad(d.stat) ? 'bad' : 'ok'">{{ statLabel(d.stat) }}</span>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.col { display: flex; flex-direction: column; gap: 20px; max-width: 720px; margin: 0 auto; }
.top { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.grow { flex: 1; }
.delay { flex: 0 0 auto; width: 120px; }
.field { width: 100%; }
.secret { max-width: 340px; }
.ov-label { margin: 22px 0 10px; }
.ov { display: flex; flex-direction: column; gap: 10px; max-width: 700px; }
.ov-row { gap: 10px; }
.sel { max-width: 210px; flex: 0 0 auto; }
.hr { height: 1px; background: var(--line); margin: 12px 0; }
.dest { justify-content: space-between; }
.dest-info { min-width: 0; }
.dest-name { font-size: 14px; font-weight: 600; }
.dest-url { font-size: 12px; color: var(--faint); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
.empty { font-size: 13px; color: var(--faint); }
.pill.none { background: var(--sub); color: var(--dim); }
.pill.ok { background: var(--ok-s); color: var(--ok); }
.pill.bad { background: var(--bad-s); color: var(--bad); }
</style>
