import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useConfig } from "./composables/useConfig";
import Landing from "./pages/Landing.vue";
import Lyrics from "./pages/Lyrics.vue";
import Settings from "./pages/Settings.vue";
import Audio from "./pages/Audio.vue";
import Webhooks from "./pages/Webhooks.vue";
import SettingsSoloist from "./pages/settings/SettingsSoloist.vue";
import SettingsSnapcast from "./pages/settings/SettingsSnapcast.vue";
import SettingsRelay from "./pages/settings/SettingsRelay.vue";
import SettingsWeb from "./pages/settings/SettingsWeb.vue";

// Top-level surfaces: Now Playing · Lyrics · Settings · Debug. Audio and Webhooks moved
// under Settings as detail pages (master-detail); Snapweb lives in the menu. Paths mirror
// web.ts APP_PATHS; unknown paths fall back to Now. History mode preserves deep-links.
const routes: RouteRecordRaw[] = [
  { path: "/", name: "now", component: Landing },
  { path: "/lyrics", name: "lyrics", component: Lyrics },
  {
    path: "/settings",
    component: Settings,
    children: [
      { path: "", redirect: "/settings/soloist" },
      { path: "soloist", name: "settings-soloist", component: SettingsSoloist },
      { path: "audio", name: "settings-audio", component: Audio },
      { path: "snapcast", name: "settings-snapcast", component: SettingsSnapcast },
      { path: "webhooks", name: "settings-webhooks", component: Webhooks },
      { path: "relay", name: "settings-relay", component: SettingsRelay },
      { path: "web", name: "settings-web", component: SettingsWeb },
    ],
  },
  // Lazy so hljs + its theme CSS split into a Debug-only async chunk (ADR-0018), never
  // the main bundle.
  { path: "/debug", name: "debug", component: () => import("./pages/Debug.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({ history: createWebHistory(), routes });

// Docker-only sections (Audio fan-out + Snapcast, ADR-0015) are unreachable in standalone,
// not just hidden from the nav. Unknown (pre-load) is treated as Docker so a cold deep-link
// in a container never redirects.
router.beforeEach(async (to) => {
  if (to.name === "settings-audio" || to.name === "settings-snapcast") {
    const { summary, loaded, load } = useConfig();
    if (!loaded.value) {
      try { await load(); } catch { /* leave dockerMode unknown -> treated as Docker */ }
    }
    if (summary.dockerMode === false) return { name: "settings-soloist" };
  }
});
