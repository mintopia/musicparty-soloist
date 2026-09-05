<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useTheme } from "../composables/useTheme";
import { useAppControl } from "../composables/useAppControl";
import { usePlayback } from "../composables/usePlayback";
import { badgeLevel, soloistLevel, relayLevel, webhookLevel, soloistText, type BadgeLevel } from "../lib/menuStatus";

const { theme, toggle } = useTheme();
const ctl = useAppControl();
const playback = usePlayback();

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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      <span class="badge" :class="`lvl-${badge}`" aria-hidden="true"></span>
    </button>

    <div v-if="open" id="appmenu-panel" ref="panel" class="panel" aria-label="Menu">
      <button data-menuitem class="item" type="button" @click="toggle">
        <svg v-if="theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <span>{{ theme === "dark" ? "Light mode" : "Dark mode" }}</span>
      </button>

      <RouterLink data-menuitem class="item" to="/debug" @click="closeMenu()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3M16 2v3M9 15h6M12 12v6"/><rect x="4" y="6" width="16" height="14" rx="3"/></svg>
        <span>Debug</span>
      </RouterLink>

      <form method="POST" action="/logout" class="logout-form">
        <button data-menuitem class="item" type="submit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
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
  position: relative; width: 36px; height: 36px; border-radius: 9px; border: 1px solid var(--line2);
  background: var(--card); color: var(--dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
}
.trigger:hover { border-color: var(--ind); color: var(--ind); }

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
.item:hover { background: rgba(0, 0, 0, .04); }
.item:hover svg { color: var(--ind); }
.logout-form { margin: 0; }

.divider { height: 1px; background: var(--line); margin: 6px 4px; }

.status { list-style: none; margin: 0; padding: 4px 4px 2px; display: flex; flex-direction: column; gap: 2px; }
.statusrow { display: flex; align-items: center; gap: 8px; padding: 5px 7px; font-size: 12.5px; }
.statusrow .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.statusrow .k { color: var(--dim); font-weight: 600; }
.statusrow .v { margin-left: auto; color: var(--txt); font-weight: 600; }
</style>
