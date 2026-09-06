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

// Paths mirror web.ts APP_PATHS.
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
  // Lazy so hljs + its theme CSS split into a Debug-only async chunk, never the main bundle.
  { path: "/debug", name: "debug", component: () => import("./pages/Debug.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({ history: createWebHistory(), routes });

const DOCKER_ONLY_ROUTES = new Set(["settings-audio", "settings-snapcast"]);
router.beforeEach(async (to) => {
  if (!DOCKER_ONLY_ROUTES.has(to.name as string)) return;
  const { summary, loaded, load } = useConfig();
  if (!loaded.value) await load().catch(() => {});
  const confirmedStandalone = summary.dockerMode === false;
  if (confirmedStandalone) return { name: "settings-soloist" };
});
