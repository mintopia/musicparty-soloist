<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { PhMusicNotesSimple } from "@phosphor-icons/vue";
import { useConfig } from "./composables/useConfig";
import { usePlayback } from "./composables/usePlayback";
import { useAppControl } from "./composables/useAppControl";
import MiniPlayer from "./components/MiniPlayer.vue";
import SiteFooter from "./components/SiteFooter.vue";
import AppMenu from "./components/AppMenu.vue";

const cfg = useConfig();
const playback = usePlayback();

// Standalone (npx) has no Snapcast fan-out (ADR-0015). Treat "unknown" (pre-load) as
// Docker so the existing container UI never flickers; hide Docker-only chrome only once
// the summary confirms standalone.
const standalone = computed(() => cfg.summary.dockerMode === false);

// Snapweb link shows only when the Snapcast HTTP server is enabled. Treat "unknown"
// (pre-load) as enabled so the link never flickers out on the existing container UI.
const snapwebEnabled = computed(() => cfg.summary.snapweb !== false);

// Top-level surfaces. Audio + Webhooks now live inside Settings (master-detail); Debug is
// promoted from the menu. `exact` keeps "/" from matching every nested route.
const tabs = [
  { to: "/", label: "Now Playing", exact: true },
  { to: "/lyrics", label: "Lyrics" },
  { to: "/settings", label: "Settings" },
  { to: "/debug", label: "Debug" },
];

// Explicit active check: RouterLink's own active-class mis-handles the /settings child
// redirect, so a section deep-link wouldn't light the Settings tab. Prefix-match instead.
const route = useRoute();
function isActive(t: { to: string; exact?: boolean }) {
  return t.exact ? route.path === t.to : route.path === t.to || route.path.startsWith(t.to + "/");
}

// Snapweb (Snapcast web UI) runs on the deployment host's port 1780 (docker-compose).
// Lives in the menu now, not the top bar.
const snapwebUrl = `http://${location.hostname}:1780`;
const showSnapweb = computed(() => !standalone.value && snapwebEnabled.value);

// Save bar: hidden when clean/idle; "Saving…" mid-flight; the failure message when a save
// errored (checked before dirty, since a failed save leaves edits dirty); "Unsaved changes"
// when dirty; "Saved" briefly after a successful save.
const saveLabel = computed(() => {
  if (cfg.status.value === "saving") return "Saving…";
  if (cfg.status.value === "error") return cfg.error.value || "Save failed — retry";
  if (cfg.dirty.value) return "Unsaved changes";
  if (cfg.status.value === "saved") return "Saved";
  return "";
});
const showSaveBar = computed(() => saveLabel.value !== "");

onMounted(() => {
  playback.start();
  useAppControl().start();
  cfg.load().catch(() => {});
});

// Discard drops every unsaved edit with no undo, so route it through a native <dialog>
// confirm. When nothing is dirty there's nothing to lose, so skip the prompt.
const confirmDlg = ref<HTMLDialogElement | null>(null);
function askDiscard() {
  if (!cfg.dirty.value) { cfg.discard(); return; }
  confirmDlg.value?.showModal();
}
function confirmDiscard() {
  confirmDlg.value?.close();
  cfg.discard();
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brandmark">
          <PhMusicNotesSimple :size="20" weight="bold" color="#fff" />
        </div>
        <div class="brandtxt">Soloist Proxy</div>
      </div>

      <nav class="nav">
        <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab" :class="{ act: isActive(t) }">
          {{ t.label }}
        </RouterLink>
      </nav>

      <div class="spacer"></div>

      <MiniPlayer />

      <AppMenu :nav-items="tabs" :snapweb-url="snapwebUrl" :show-snapweb="showSnapweb" />
    </header>

    <div v-if="cfg.summary.pendingRestart" class="banner">
      <span>Soloist needs a restart to apply changes.</span>
      <button class="btn pri-warn" @click="cfg.restartSoloist()">Restart</button>
    </div>

    <div v-if="cfg.summary.pendingSnapcastRestart" class="banner">
      <span>Snapcast needs a restart to apply the server config.</span>
      <button class="btn pri-warn" @click="cfg.restartSnapcast()">Restart Snapcast</button>
    </div>

    <main class="wrap">
      <RouterView />
    </main>

    <SiteFooter />

    <div v-if="showSaveBar" class="savebar">
      <span class="save-label" :class="{ 'save-error': cfg.status.value === 'error' }" role="status">{{ saveLabel }}</span>
      <span class="save-actions">
        <button class="btn" :disabled="cfg.status.value === 'saving'" @click="askDiscard()">Discard</button>
        <button class="btn pri" :disabled="!cfg.dirty.value || cfg.status.value === 'saving'" @click="cfg.save()">Save</button>
      </span>
    </div>

    <dialog ref="confirmDlg" class="confirm" aria-labelledby="confirm-title">
      <h2 id="confirm-title" class="confirm-title">Discard changes?</h2>
      <p class="confirm-body">
        Discard {{ cfg.dirtyCount.value }} unsaved change{{ cfg.dirtyCount.value === 1 ? "" : "s" }}? This can't be undone.
      </p>
      <div class="confirm-actions">
        <button type="button" class="btn" @click="confirmDlg?.close()">Cancel</button>
        <button type="button" class="btn pri-warn" @click="confirmDiscard()">Discard</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; display: flex; flex-direction: column; }

/* Docked, full-bleed top bar (vanilla #topbar). */
.topbar {
  position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: 14px;
  padding: 9px 20px; background: var(--bar);
  backdrop-filter: blur(20px) saturate(1.6); -webkit-backdrop-filter: blur(20px) saturate(1.6);
  border-bottom: 1px solid var(--line2);
  box-shadow: 0 6px 22px rgba(30, 30, 40, .06), inset 0 1px 0 rgba(255, 255, 255, .55);
}
:root[data-theme="dark"] .topbar {
  border-bottom-color: rgba(255, 255, 255, .06);
  box-shadow: 0 8px 26px rgba(0, 0, 0, .34), inset 0 1px 0 rgba(255, 255, 255, .05);
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
.tab.act { background: var(--ind-s); color: var(--link); }

.spacer { flex: 1; }
.snapweb { text-decoration: none; }

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
  padding: 12px 22px; background: var(--savebar);
  backdrop-filter: blur(16px) saturate(1.5); -webkit-backdrop-filter: blur(16px) saturate(1.5);
  border-top: 1px solid var(--line2);
  box-shadow: 0 -6px 22px rgba(30, 30, 40, .06), inset 0 1px 0 rgba(255, 255, 255, .5);
}
:root[data-theme="dark"] .savebar {
  box-shadow: 0 -8px 26px rgba(0, 0, 0, .34), inset 0 1px 0 rgba(255, 255, 255, .05);
}
.save-label { font-weight: 600; font-size: 13px; color: var(--dim); }
.save-label.save-error { color: var(--bad); }
.save-actions { display: flex; gap: 8px; }

@media (max-width: 860px) {
  /* Mobile collapses to hamburger-only: the horizontal nav and mini-player drop out, the
     menu carries the sections (App-Menu renders them below this breakpoint). */
  .topbar { gap: 8px 10px; padding: 8px 13px; }
  .nav { display: none; }
  .wrap { padding: 18px 15px; }
}

/* First modal in the app. Native <dialog> gives focus-trap, ESC-to-cancel and backdrop for
   free; tokens match the menu/auth floating-panel treatment (--sh2). */
.confirm {
  border: 1px solid var(--line2); border-radius: 16px; background: var(--card); color: var(--txt);
  box-shadow: var(--sh2); padding: 22px; max-width: 380px; width: calc(100% - 40px);
}
.confirm::backdrop { background: rgba(20, 20, 30, .45); }
.confirm-title { font-family: var(--disp); font-size: 16px; font-weight: 700; margin: 0 0 8px; }
.confirm-body { font-size: 13px; color: var(--dim); line-height: 1.5; margin: 0 0 18px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
