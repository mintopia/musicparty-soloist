<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useConfig } from "../../composables/useConfig";
import SectionCard from "../../components/SectionCard.vue";
import TextField from "../../components/TextField.vue";
import SecretRow from "../../components/SecretRow.vue";

const { config, secretSet, loaded } = useConfig();
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
  <div v-if="!loaded" class="lbl">Loading…</div>
  <SectionCard
    v-else
    title="WebSocket Relay"
    subtitle="Bridge Soloist to an external server: outbound frames are republished, received frames are relayed back as commands."
  >
    <div class="relay-head">
      <div class="relay-pill">
        <span class="pill" :class="pill.cls"><span class="dot"></span>{{ pill.text }}</span>
        <div v-if="relay.enabled && !relay.connected && relay.lastError" class="relay-err" :title="relay.lastError">
          {{ relay.lastError }}
        </div>
      </div>
    </div>
    <div class="grid2">
      <TextField label="Relay URL" placeholder="wss://example.com/relay" v-model="c.relay.url" />
      <SecretRow
        label="Authorization Header" section="relay" field-key="authorization" revealable
        :is-set="secretSet['relay.authorization']" v-model="c.relay.authorization"
      />
    </div>
  </SectionCard>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px; align-items: start; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
.relay-head { display: flex; justify-content: flex-end; margin-bottom: 14px; }
.relay-pill { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.relay-err { font-size: 11.5px; color: var(--faint); max-width: 340px; text-align: right; overflow-wrap: break-word; word-break: break-word; }
.pill.disabled { background: var(--sub); color: var(--dim); }
.pill.disabled .dot { background: var(--dim); }
.pill.connected { background: var(--ok-s); color: var(--ok); }
.pill.connected .dot { background: var(--ok); }
.pill.reconnecting { background: var(--warn-s); color: var(--warn); }
.pill.reconnecting .dot { background: var(--warn); }
</style>
