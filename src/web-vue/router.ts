import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import Landing from "./pages/Landing.vue";
import Audio from "./pages/Audio.vue";
import Webhooks from "./pages/Webhooks.vue";
import Lyrics from "./pages/Lyrics.vue";
import Settings from "./pages/Settings.vue";

// Paths mirror web.ts APP_PATHS; unknown paths fall back to Now. History mode replaces
// the old hand-rolled pushState/popstate, preserving deep-links and back/forward.
const routes: RouteRecordRaw[] = [
  { path: "/", name: "now", component: Landing },
  { path: "/audio", name: "audio", component: Audio },
  { path: "/webhooks", name: "webhooks", component: Webhooks },
  { path: "/lyrics", name: "lyrics", component: Lyrics },
  { path: "/settings", name: "settings", component: Settings },
  // Lazy so hljs + its theme CSS split into a Debug-only async chunk (ADR-0018), never
  // the main bundle.
  { path: "/debug", name: "debug", component: () => import("./pages/Debug.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({ history: createWebHistory(), routes });
