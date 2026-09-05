<script setup lang="ts">
import { computed, type Component } from "vue";
import { useConfig } from "../composables/useConfig";
import { PhSpotifyLogo, PhSpeakerHifi, PhBroadcast, PhWebhooksLogo, PhPlugs, PhLock } from "@phosphor-icons/vue";

const { summary } = useConfig();

// Docker-only sections (Audio fan-out + Snapcast) are hidden in standalone (ADR-0015).
// Treat "unknown" (pre-load) as Docker so the nav never flickers items out.
const docker = computed(() => summary.dockerMode !== false);

interface Item { to: string; label: string; icon: Component; docker?: boolean }
const items = computed<Item[]>(() =>
  [
    { to: "/settings/soloist", label: "Soloist", icon: PhSpotifyLogo },
    { to: "/settings/audio", label: "Audio Outputs", icon: PhSpeakerHifi, docker: true },
    { to: "/settings/snapcast", label: "Snapcast", icon: PhBroadcast, docker: true },
    { to: "/settings/webhooks", label: "Webhooks", icon: PhWebhooksLogo },
    { to: "/settings/relay", label: "WebSocket Relay", icon: PhPlugs },
    { to: "/settings/web", label: "Web Access", icon: PhLock },
  ].filter((i) => (i.docker ? docker.value : true)),
);
</script>

<template>
  <div class="settings">
    <nav class="side" aria-label="Settings sections">
      <RouterLink v-for="it in items" :key="it.to" :to="it.to" class="navi" active-class="act">
        <component :is="it.icon" :size="17" weight="fill" />
        <span>{{ it.label }}</span>
      </RouterLink>
    </nav>
    <div class="detail">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
.settings { display: grid; grid-template-columns: 208px minmax(0, 1fr); gap: 22px; align-items: start; max-width: 940px; margin: 0 auto; }
.side { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 78px; }
.navi svg { flex: 0 0 auto; color: var(--faint); }
.navi:hover { color: var(--txt); background: rgba(125, 125, 125, .08); }
.navi.act { color: var(--link); }
.navi.act svg { color: var(--link); }
.detail { min-width: 0; }

@media (max-width: 720px) {
  .settings { grid-template-columns: 1fr; gap: 14px; }
  .side { position: static; flex-direction: row; gap: 6px; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
  .navi { white-space: nowrap; flex: 0 0 auto; }
  .navi span { display: inline; }
}
</style>
