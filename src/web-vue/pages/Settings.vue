<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useConfig } from "../composables/useConfig";
import SectionCard from "../components/SectionCard.vue";
import TextField from "../components/TextField.vue";
import SecretRow from "../components/SecretRow.vue";
import ToggleSwitch from "../components/ToggleSwitch.vue";

const { config, summary, secretSet, loaded } = useConfig();
// The working copy is a reactive Record; the typed accessors below are only for the
// template's benefit. Writing through it auto-flips `dirty` — no markDirty needed.
const c = config as any;

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
        <TextField v-if="!summary.dockerMode" label="Soloist WS" v-model="c.soloistWs" />
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

.setrow {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line);
}
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
