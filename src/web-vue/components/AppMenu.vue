<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Component } from "vue";
import { useRoute } from "vue-router";
import { PhList, PhPlayCircle, PhMicrophoneStage, PhGearSix, PhTerminal, PhBroadcast, PhArrowUpRight, PhSun, PhMoon, PhSignOut } from "@phosphor-icons/vue";
import { useTheme } from "../composables/useTheme";
import { useAppControl } from "../composables/useAppControl";
import { usePlayback } from "../composables/usePlayback";
import { badgeLevel, soloistLevel, relayLevel, webhookLevel, soloistText, type BadgeLevel } from "../lib/menuStatus";

defineProps<{
  navItems: { to: string; label: string; exact?: boolean }[];
  snapwebUrl: string;
  showSnapweb: boolean;
}>();

const { theme, toggle } = useTheme();
const ctl = useAppControl();
const playback = usePlayback();

const NAV_ICONS: Record<string, Component> = {
  "/": PhPlayCircle,
  "/lyrics": PhMicrophoneStage,
  "/settings": PhGearSix,
  "/debug": PhTerminal,
};

// Prefix-match active state (RouterLink's own mis-handles the /settings child redirect).
const route = useRoute();
function isCurrent(n: { to: string; exact?: boolean }) {
  return n.exact ? route.path === n.to : route.path === n.to || route.path.startsWith(n.to + "/");
}

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);

// App-Control telemetry is trustworthy only while its socket is open and the latest
// proxy_status is fresh (ADR-0017): a stale/absent frame reads as unknown, never green.
const appLive = computed(() => ctl.connected.value && !ctl.stale.value);
const dataConnected = computed(() => playback.state.connected);
const status = computed(() => ctl.status.value);
const soloist = computed(() => status.value?.soloist ?? null);
const relay = computed(() => status.value?.relay ?? null);
const webhookOk = computed(() => (status.value?.webhook ? status.value.webhook.ok : null));

const badge = computed<BadgeLevel>(() =>
  badgeLevel({
    appLive: appLive.value,
    dataConnected: dataConnected.value,
    soloist: soloist.value,
    relay: relay.value,
    webhookOk: webhookOk.value,
  }),
);

const BADGE_SUMMARY: Record<BadgeLevel, string> = {
  green: "all healthy",
  amber: "needs attention",
  red: "problem",
};

const soloistLine = computed(() => ({
  value: soloistText(soloist.value, appLive.value, dataConnected.value),
  level: soloistLevel(soloist.value, appLive.value, dataConnected.value),
}));
const clientLine = computed(() => ({
  value: appLive.value && status.value ? String(status.value.clients) : "—",
  level: "green" as BadgeLevel,
}));
const relayLine = computed(() => {
  const r = relay.value;
  let value = "—";
  if (appLive.value && r) value = !r.enabled ? "Disabled" : r.connected ? "Connected" : "Disconnected";
  return { value, level: relayLevel(r, appLive.value) };
});
const webhookLine = computed(() => {
  const w = status.value?.webhook ?? null;
  let value = "—";
  if (appLive.value) value = w ? `${w.ok ? "OK" : "Failed"} · ${w.status ?? "—"}` : "None yet";
  return { value, level: webhookLevel(webhookOk.value, appLive.value) };
});

function openMenu() {
  open.value = true;
  nextTick(() => panel.value?.querySelector<HTMLElement>("[data-menuitem]")?.focus());
}
function closeMenu(refocus = false) {
  open.value = false;
  if (refocus) trigger.value?.focus();
}
function toggleMenu() {
  open.value ? closeMenu() : openMenu();
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) {
    e.stopPropagation();
    closeMenu(true);
  }
}
function onDocPointer(e: PointerEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) closeMenu();
}
function onFocusout(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  if (open.value && next && root.value && !root.value.contains(next)) closeMenu();
}

onMounted(() => document.addEventListener("pointerdown", onDocPointer));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointer));
</script>

<template>
  <div ref="root" class="appmenu" @keydown="onKeydown" @focusout="onFocusout">
    <button
      ref="trigger"
      class="trigger"
      type="button"
      aria-haspopup="true"
      :aria-expanded="open"
      aria-controls="appmenu-panel"
      :aria-label="`Menu — status: ${BADGE_SUMMARY[badge]}`"
      @click="toggleMenu"
    >
      <PhList :size="18" weight="bold" />
      <span class="badge" :class="`lvl-${badge}`" aria-hidden="true"></span>
    </button>

    <div v-if="open" id="appmenu-panel" ref="panel" class="panel" aria-label="Menu">
      <nav class="menu-nav" aria-label="Sections">
        <RouterLink
          v-for="n in navItems" :key="n.to" data-menuitem class="item nav-item" :to="n.to"
          :class="{ cur: isCurrent(n) }" @click="closeMenu()"
        >
          <component :is="NAV_ICONS[n.to]" :size="16" weight="bold" />
          <span>{{ n.label }}</span>
        </RouterLink>
        <div class="divider" role="separator"></div>
      </nav>

      <a
        v-if="showSnapweb" data-menuitem class="item" :href="snapwebUrl"
        target="_blank" rel="noopener" @click="closeMenu()"
      >
        <PhBroadcast :size="16" weight="bold" />
        <span>Snapweb</span>
        <PhArrowUpRight class="ext" :size="13" weight="bold" />
      </a>

      <button data-menuitem class="item" type="button" @click="toggle">
        <PhSun v-if="theme === 'dark'" :size="16" weight="bold" />
        <PhMoon v-else :size="16" weight="bold" />
        <span>{{ theme === "dark" ? "Light mode" : "Dark mode" }}</span>
      </button>

      <form method="POST" action="/logout" class="logout-form">
        <button data-menuitem class="item" type="submit">
          <PhSignOut :size="16" weight="bold" />
          <span>Log out</span>
        </button>
      </form>

      <div class="divider" role="separator"></div>

      <ul class="status" aria-label="Live status">
        <li class="statusrow">
          <span class="dot" :class="`lvl-${soloistLine.level}`" aria-hidden="true"></span>
          <span class="k">Soloist</span>
          <span class="v">{{ soloistLine.value }}</span>
        </li>
        <li class="statusrow">
          <span class="dot" :class="`lvl-${clientLine.level}`" aria-hidden="true"></span>
          <span class="k">Client Count</span>
          <span class="v">{{ clientLine.value }}</span>
        </li>
        <li class="statusrow">
          <span class="dot" :class="`lvl-${relayLine.level}`" aria-hidden="true"></span>
          <span class="k">Relay</span>
          <span class="v">{{ relayLine.value }}</span>
        </li>
        <li class="statusrow">
          <span class="dot" :class="`lvl-${webhookLine.level}`" aria-hidden="true"></span>
          <span class="k">Webhook Status</span>
          <span class="v">{{ webhookLine.value }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.appmenu { position: relative; flex: 0 0 auto; }

.trigger {
  position: relative; width: 36px; height: 36px; border-radius: 9px; border: none;
  background: transparent; color: var(--dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
}
.trigger:hover { color: var(--ind); background: rgba(125, 125, 135, .12); }

.badge {
  position: absolute; top: -3px; right: -3px; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--bar);
}
.lvl-green { background: var(--ok); }
.lvl-amber { background: var(--warn); }
.lvl-red { background: var(--bad); }

.panel {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 50; min-width: 240px;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--sh2);
  padding: 6px;
}

.item {
  display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;
  padding: 9px 11px; border: 0; border-radius: 9px; background: transparent; cursor: pointer;
  font: 600 13px var(--sans); color: var(--txt); text-decoration: none; text-align: left;
}
.item svg { color: var(--dim); flex: 0 0 auto; }
.item:hover { background: rgba(125, 125, 135, .14); }
.item:hover svg { color: var(--ind); }
.logout-form { margin: 0; }

.menu-nav { display: none; }
@media (max-width: 860px) { .menu-nav { display: block; } }
.nav-item.cur { background: var(--ind-s); color: var(--link); }
.nav-item.cur svg { color: var(--link); }
.item .ext { margin-left: auto; color: var(--faint); }
.item:hover .ext { color: var(--ind); }

.divider { height: 1px; background: var(--line); margin: 6px 4px; }

.status { list-style: none; margin: 0; padding: 4px 4px 2px; display: flex; flex-direction: column; gap: 2px; }
.statusrow { display: flex; align-items: center; gap: 8px; padding: 5px 7px; font-size: 12.5px; }
.statusrow .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.statusrow .k { color: var(--dim); font-weight: 600; }
.statusrow .v { margin-left: auto; color: var(--txt); font-weight: 600; }
</style>
