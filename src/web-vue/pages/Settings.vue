<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useConfig } from "../composables/useConfig";
import SectionCard from "../components/SectionCard.vue";
import TextField from "../components/TextField.vue";
import SecretRow from "../components/SecretRow.vue";
import ToggleSwitch from "../components/ToggleSwitch.vue";

const { config, summary, secretSet, loaded } = useConfig();

// Placeholder tokens shown in the Snapcast config hint. Kept as string constants because a
// literal "{{…}}" in the template would be parsed as a Vue interpolation.
const streamPh = "{{stream}}";
const snapwebPh = "{{snapweb}}";
// The working copy is a reactive Record; the typed accessors below are only for the
// template's benefit. Writing through it auto-flips `dirty` — no markDirty needed.
const c = config as any;

// Standalone-only PipeWire output-device picker (ADR-0015). Soloist auto-connects to
// some sink when none is pinned, which is often the wrong one (e.g. the Pi headphone
// jack instead of a DAC HAT) — so let the operator choose from the host's real sinks.
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

// Load once the config summary says we're standalone (the picker is hidden in Docker).
watch(loaded, (ok) => { if (ok && !summary.dockerMode) loadSinks(); }, { immediate: true });

// Sink options plus, if the configured device isn't among them, the stored value itself
// (labelled "not detected") so a manual/stale name is never silently dropped on save.
const deviceOptions = computed(() => {
  const opts = sinks.value.map((s) => ({ value: s.name, label: s.description || s.name }));
  const cur = String(c.soloist?.pipewireDevice ?? "");
  if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `${cur} (not detected)` });
  return opts;
});

interface RelayStatus { enabled: boolean; connected: boolean; lastError: string | null }
const relay = ref<RelayStatus>({ enabled: false, connected: false, lastError: null });
let timer: number | undefined;

async function refreshRelay() {
  try {
    const r = await fetch("/api/relay", { credentials: "same-origin" });
    if (r.ok) relay.value = (await r.json()).status;
  } catch { /* keep last known status */ }
}

// Relay status is live; poll only while this tab is mounted (item: refresh while open).
onMounted(() => { refreshRelay(); timer = window.setInterval(refreshRelay, 3000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

const pill = computed(() => {
  const s = relay.value;
  if (!s.enabled) return { cls: "disabled", text: "Disabled" };
  if (s.connected) return { cls: "connected", text: "Connected" };
  return { cls: "reconnecting", text: "Reconnecting…" };
});
</script>

<template>
  <div v-if="!loaded" class="fcol"><p class="lbl">Loading…</p></div>
  <div v-else class="fcol">
    <SectionCard title="Soloist">
      <div class="grid2">
        <TextField label="Device name" v-model="c.soloist.deviceName" />
        <div v-if="!summary.dockerMode" class="tf">
          <div class="dev-label">
            <label class="flabel">PipeWire output device</label>
            <button type="button" class="linkbtn" :disabled="sinksLoading" @click="loadSinks">
              {{ sinksLoading ? "Refreshing…" : "Refresh" }}
            </button>
          </div>
          <select class="field" v-model="c.soloist.pipewireDevice">
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

    <SectionCard v-if="summary.dockerMode" title="Snapcast" subtitle="Multi-room audio server (Docker). Changes apply after a Snapcast restart.">
      <div class="setrow first">
        <div class="setrow-txt">
          <div class="setrow-title">Enable Snapweb</div>
          <div class="setrow-sub">Serve the Snapcast web UI and show its link in the top bar.</div>
        </div>
        <ToggleSwitch :on="c.snapweb" label="Enable Snapweb" @toggle="c.snapweb = !c.snapweb" />
      </div>
      <div class="tf snap-conf">
        <label class="flabel">Snapcast server config</label>
        <textarea class="field mono" rows="12" spellcheck="false" v-model="c.snapcastServerConfig"></textarea>
        <div class="dev-hint">
          <code>{{ streamPh }}</code> expands to the capture source line,
          <code>{{ snapwebPh }}</code> to the Snapweb enable flag (true/false).
        </div>
      </div>
    </SectionCard>

    <SectionCard
      title="WebSocket relay"
      subtitle="Bridge Soloist to an external server: outbound frames are republished, received frames are relayed back as commands."
    >
      <div class="relay-head">
        <div class="relay-pill">
          <span class="pill" :class="pill.cls"><span class="dot"></span>{{ pill.text }}</span>
          <div v-if="relay.enabled && !relay.connected && relay.lastError" class="relay-err">
            {{ relay.lastError }}
          </div>
        </div>
      </div>
      <div class="grid2">
        <TextField label="Relay URL" placeholder="wss://example.com/relay" v-model="c.relay.url" />
        <SecretRow
          label="Authorization header" section="relay" field-key="authorization" revealable
          :is-set="secretSet['relay.authorization']" v-model="c.relay.authorization"
        />
      </div>
    </SectionCard>

    <SectionCard title="Web access">
      <div class="grid2">
        <TextField label="Username" v-model="c.web.username" />
        <SecretRow
          label="Password" section="web" field-key="password"
          :is-set="secretSet['web.password']" v-model="c.web.password"
        />
      </div>
    </SectionCard>
  </div>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px; align-items: start; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }

.tf .field { width: 100%; }
.dev-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.linkbtn {
  background: none; border: none; padding: 0; cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--ind);
}
.linkbtn:disabled { color: var(--faint); cursor: default; }
.dev-hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }

.setrow {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line);
}
.setrow.first { margin-top: 0; padding-top: 0; border-top: none; }
.snap-conf { margin-top: 20px; }
.snap-conf .field { width: 100%; box-sizing: border-box; }
textarea.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.5; resize: vertical; }
.snap-conf code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--sub); padding: 1px 4px; border-radius: 4px; }
.setrow-txt { min-width: 0; }
.setrow-title { font-size: 14px; font-weight: 600; }
.setrow-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
.sw { cursor: pointer; }

.relay-head { display: flex; justify-content: flex-end; margin-bottom: 14px; }
.relay-pill { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.relay-err {
  font-size: 11.5px; color: var(--faint); max-width: 340px; text-align: right;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pill.disabled { background: var(--sub); color: var(--dim); }
.pill.disabled .dot { background: var(--dim); }
.pill.connected { background: var(--ok-s); color: var(--ok); }
.pill.connected .dot { background: var(--ok); }
.pill.reconnecting { background: var(--warn-s); color: var(--warn); }
.pill.reconnecting .dot { background: var(--warn); }
</style>
