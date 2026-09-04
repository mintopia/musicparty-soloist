<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useTheme } from "./composables/useTheme";
import { useConfig } from "./composables/useConfig";
import { usePlayback } from "./composables/usePlayback";

const { theme, toggle } = useTheme();
const cfg = useConfig();
const playback = usePlayback();

const tabs = [
  { to: "/", label: "Now" },
  { to: "/audio", label: "Audio" },
  { to: "/webhooks", label: "Webhooks" },
  { to: "/lyrics", label: "Lyrics" },
  { to: "/settings", label: "Settings" },
];

// Save bar: hidden when clean/idle; "Saving…" mid-flight; "Unsaved changes" when dirty;
// "Saved" briefly after a successful save.
const saveLabel = computed(() => {
  if (cfg.status.value === "saving") return "Saving…";
  if (cfg.dirty.value) return "Unsaved changes";
  if (cfg.status.value === "saved") return "Saved";
  return "";
});
const showSaveBar = computed(() => saveLabel.value !== "");

onMounted(() => {
  playback.start();
  cfg.load().catch(() => { /* boot errors surface in later view tickets */ });
});
</script>

<template>
  <div class="app">
    <header class="topbar glassbar">
      <div class="brand">Soloist Proxy</div>
      <nav class="tabs">
        <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="navi" exact-active-class="act">
          {{ t.label }}
        </RouterLink>
      </nav>
      <div class="topbar-right">
        <!-- mini-player mounts here in a later ticket -->
        <div id="mini-player" class="mini-player-mount"></div>
        <button class="btn theme-toggle" :title="theme === 'dark' ? 'Switch to light' : 'Switch to dark'" @click="toggle">
          {{ theme === "dark" ? "☾" : "☀" }}
        </button>
      </div>
    </header>

    <div v-if="cfg.summary.pendingRestart" class="banner">
      <span>Soloist needs a restart to apply changes.</span>
      <button class="btn" @click="cfg.restartSoloist()">Restart</button>
    </div>

    <main class="content">
      <RouterView />
    </main>

    <div v-if="showSaveBar" class="savebar glassbar">
      <span class="save-label">{{ saveLabel }}</span>
      <span class="save-actions">
        <button class="btn" :disabled="cfg.status.value === 'saving'" @click="cfg.discard()">Discard</button>
        <button class="btn pri" :disabled="!cfg.dirty.value || cfg.status.value === 'saving'" @click="cfg.save()">Save</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.app { max-width: 1180px; margin: 0 auto; padding: 26px 30px 96px; }
.topbar {
  position: sticky; top: 12px; z-index: 10; display: flex; align-items: center; gap: 20px;
  padding: 10px 16px; border-radius: 16px; margin-bottom: 20px;
}
.brand { font-family: var(--disp); font-weight: 700; font-size: 18px; letter-spacing: -.015em; }
.tabs { display: flex; gap: 4px; }
.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.theme-toggle { font-size: 15px; line-height: 1; padding: 8px 11px; }
.banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: var(--warn-s); border: 1px solid #f0d9a8; color: var(--warn);
  border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; font-weight: 600; font-size: 13px;
}
.savebar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 18px; padding: 10px 16px; border-radius: 14px; z-index: 20;
}
.save-label { font-weight: 600; font-size: 13px; color: var(--dim); }
.save-actions { display: flex; gap: 8px; }
</style>
