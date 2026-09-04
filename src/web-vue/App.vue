<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useTheme } from "./composables/useTheme";
import { useConfig } from "./composables/useConfig";
import { usePlayback } from "./composables/usePlayback";
import MiniPlayer from "./components/MiniPlayer.vue";
import SiteFooter from "./components/SiteFooter.vue";

const { theme, toggle } = useTheme();
const cfg = useConfig();
const playback = usePlayback();

const tabs = [
  { to: "/", label: "Now Playing" },
  { to: "/audio", label: "Audio" },
  { to: "/webhooks", label: "Webhooks" },
  { to: "/lyrics", label: "Lyrics" },
  { to: "/settings", label: "Settings" },
];

// Snapweb (Snapcast web UI) runs on the deployment host's port 1780 (docker-compose).
const snapwebUrl = `http://${location.hostname}:1780`;

// Control-WS connection status pill (mirrors setWsPill in the vanilla playback.js).
const connected = computed(() => playback.state.connected);

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
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brandmark">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
        </div>
        <div class="brandtxt">Soloist Proxy</div>
      </div>

      <nav class="nav">
        <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab" exact-active-class="act">
          {{ t.label }}
        </RouterLink>
      </nav>

      <div class="spacer"></div>

      <MiniPlayer />

      <a class="btn snapweb" :href="snapwebUrl" target="_blank" rel="noopener" title="Open Snapweb">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 10v4M7 6v12M11 3v18M15 8v8M19 5v14"/></svg>
        Snapweb
      </a>

      <span class="pill" :class="connected ? 'ws-ok' : 'ws-down'">
        <span class="dot"></span>{{ connected ? "Connected" : "Reconnecting…" }}
      </span>

      <button class="iconbtn" :title="theme === 'dark' ? 'Switch to light' : 'Switch to dark'" @click="toggle">
        <svg v-if="theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>

      <form method="POST" action="/logout" class="logout">
        <button class="iconbtn" type="submit" title="Sign out">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </form>
    </header>

    <div v-if="cfg.summary.pendingRestart" class="banner">
      <span>Soloist needs a restart to apply changes.</span>
      <button class="btn" @click="cfg.restartSoloist()">Restart</button>
    </div>

    <main class="wrap">
      <RouterView />
    </main>

    <SiteFooter />

    <div v-if="showSaveBar" class="savebar">
      <span class="save-label">{{ saveLabel }}</span>
      <span class="save-actions">
        <button class="btn" :disabled="cfg.status.value === 'saving'" @click="cfg.discard()">Discard</button>
        <button class="btn pri" :disabled="!cfg.dirty.value || cfg.status.value === 'saving'" @click="cfg.save()">Save</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; display: flex; flex-direction: column; }

/* Docked, full-bleed top bar (vanilla #topbar). */
.topbar {
  position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: 14px;
  padding: 9px 20px; background: var(--bar); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.brandmark {
  width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(140deg, #14b8a6, #0d9488);
}
.brandtxt { font-family: var(--disp); font-size: 16px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; }

.nav { display: flex; gap: 2px; flex: 0 0 auto; flex-wrap: nowrap; }
.tab { font-size: 13px; font-weight: 600; color: var(--dim); padding: 8px 13px; border-radius: 9px; }
.tab:hover { color: var(--txt); background: rgba(0, 0, 0, .03); }
.tab.act { background: var(--ind-s); color: var(--ind); }

.spacer { flex: 1; }
.snapweb { text-decoration: none; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; }
.pill.ws-ok { background: var(--ok-s); color: var(--ok); }
.pill.ws-ok .dot { background: var(--ok); }
.pill.ws-down { background: var(--warn-s); color: var(--warn); }
.pill.ws-down .dot { background: var(--warn); }

.iconbtn {
  width: 36px; height: 36px; border-radius: 9px; border: 1px solid var(--line2); background: var(--card);
  color: var(--dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
}
.iconbtn:hover { border-color: var(--ind); color: var(--ind); }
.logout { margin: 0; }

/* Centered content column (vanilla .wrap). */
.wrap { flex: 1; width: 100%; max-width: 1200px; margin: 0 auto; padding: 24px 30px; }

.banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  max-width: 1200px; margin: 16px auto 0; box-sizing: border-box; width: 100%;
  background: var(--warn-s); border: 1px solid #f0d9a8; color: var(--warn);
  border-radius: 12px; padding: 12px 16px; font-weight: 600; font-size: 13px;
}
:root[data-theme="dark"] .banner { border-color: #6b5121; }

/* Docked, full-bleed save bar (vanilla #saveBar). */
.savebar {
  position: sticky; bottom: 0; z-index: 30; display: flex; align-items: center; justify-content: flex-end; gap: 18px;
  padding: 12px 22px; background: var(--savebar); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border-top: 1px solid var(--line);
}
.save-label { font-weight: 600; font-size: 13px; color: var(--dim); }
.save-actions { display: flex; gap: 8px; }

@media (max-width: 860px) {
  .topbar { flex-wrap: wrap; gap: 8px 10px; padding: 8px 13px; }
  .nav { order: 5; width: 100%; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 2px; }
  .wrap { padding: 18px 15px; }
}
</style>
