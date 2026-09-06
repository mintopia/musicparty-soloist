<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from "vue";
import { useAppControl, type Frame, type WebhookDelivery } from "../composables/useAppControl";
import { highlightJson } from "../lib/highlight";
import "highlight.js/styles/github.css";

const ctl = useAppControl();
const sub = ctl.subscribe(["frame", "clients", "webhooks"]);
onUnmounted(() => sub.dispose());

// Live clock so uptime ticks without a per-row timer.
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(clock));

// hljs output cache, keyed per panel. v-html only ever receives a value produced here, i.e.
// hljs.highlight's HTML-escaped output — the sole thing allowed past the XSS boundary
// (ADR-0016). Raw frames/headers/bodies otherwise reach the DOM only as text interpolation.
const hlStore = reactive<Record<string, string>>({});
async function ensureHl(key: string, src: string): Promise<void> {
  if (hlStore[key] === undefined) hlStore[key] = await highlightJson(src);
}

// The server publishes each frame verbatim with no receipt time (only a native `type`), so a
// stable id and arrival time are stamped client-side, once per frame object, in a WeakMap that
// GCs with the ring. The id-keyed expansion and highlight caches don't self-evict, so the
// frame watcher below prunes them when a frame leaves the ring.
interface FrameMeta { id: number; at: number; }
let nextFrameId = 0;
const frameMeta = new WeakMap<Frame, FrameMeta>();
function metaFor(f: Frame): FrameMeta {
  let m = frameMeta.get(f);
  if (!m) {
    m = { id: nextFrameId++, at: Date.now() };
    frameMeta.set(f, m);
  }
  return m;
}

const frameRows = computed(() =>
  sub.frames.map((f) => {
    const m = metaFor(f);
    return { id: m.id, at: m.at, type: typeof f.type === "string" ? f.type : "—", frame: f };
  }),
);

const expandedFrames = reactive(new Set<number>());
function toggleFrame(id: number, frame: Frame): void {
  if (expandedFrames.has(id)) expandedFrames.delete(id);
  else {
    expandedFrames.add(id);
    ensureHl(`frame:${id}`, JSON.stringify(frame, null, 2));
  }
}

// Autoscroll with pause-on-scroll: while the operator is scrolled up (inspecting history) new
// frames stop yanking the view; a control returns to live tail.
const logEl = ref<HTMLElement | null>(null);
const paused = ref(false);
function onLogScroll(): void {
  const el = logEl.value;
  if (!el) return;
  paused.value = el.scrollHeight - el.scrollTop - el.clientHeight > 24;
}
function scrollToLatest(): void {
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
  paused.value = false;
}

// Keyed on the newest frame id (monotonic) rather than array length, which pins at the ring
// cap and would stop firing. Doubles as the eviction hook: drop caches for frames now gone.
watch(
  () => frameRows.value.at(-1)?.id ?? -1,
  async () => {
    const live = new Set(frameRows.value.map((r) => r.id));
    for (const id of expandedFrames) if (!live.has(id)) expandedFrames.delete(id);
    for (const key of Object.keys(hlStore)) {
      if (key.startsWith("frame:") && !live.has(Number(key.slice(6)))) delete hlStore[key];
    }
    if (paused.value) return;
    await nextTick();
    scrollToLatest();
  },
);

let nextWhId = 0;
const whMeta = new WeakMap<WebhookDelivery, number>();
function whIdFor(d: WebhookDelivery): number {
  let id = whMeta.get(d);
  if (id === undefined) {
    id = nextWhId++;
    whMeta.set(d, id);
  }
  return id;
}

function whStatus(d: WebhookDelivery): { cls: string; label: string } {
  if (d.error) return { cls: "bad", label: "ERR" };
  if (d.status === null) return { cls: "warn", label: "—" };
  const ok = d.status >= 200 && d.status < 300;
  return { cls: ok ? "ok" : "bad", label: String(d.status) };
}

// Newest first; the server ring is oldest-to-newest.
const webhookRows = computed(() =>
  [...sub.webhooks].reverse().map((d) => ({ id: whIdFor(d), delivery: d, status: whStatus(d) })),
);

const expandedWebhooks = reactive(new Set<number>());
// Whether each expanded delivery's body parsed as JSON, resolved once on expand so the
// template never re-parses and the raw-vs-highlighted body choice can't flicker.
const whBodyJson = reactive<Record<number, boolean>>({});
function toggleWebhook(id: number, d: WebhookDelivery): void {
  if (expandedWebhooks.has(id)) {
    expandedWebhooks.delete(id);
    return;
  }
  expandedWebhooks.add(id);
  ensureHl(`wh:${id}:req`, JSON.stringify(d.reqHeaders, null, 2));
  ensureHl(`wh:${id}:resp`, JSON.stringify(d.respHeaders, null, 2));
  const pretty = tryPrettyJson(d.respBody);
  whBodyJson[id] = pretty !== null;
  if (pretty !== null) ensureHl(`wh:${id}:body`, pretty);
}

// Mirror the frame watcher: prune caches for deliveries evicted from the ring.
watch(
  () => webhookRows.value.at(0)?.id ?? -1,
  () => {
    const live = new Set(webhookRows.value.map((r) => r.id));
    for (const id of expandedWebhooks) if (!live.has(id)) expandedWebhooks.delete(id);
    for (const id of Object.keys(whBodyJson)) if (!live.has(Number(id))) delete whBodyJson[Number(id)];
    for (const key of Object.keys(hlStore)) {
      if (key.startsWith("wh:") && !live.has(Number(key.split(":")[1]))) delete hlStore[key];
    }
  },
);

// Pretty-print a body only if it is valid JSON; otherwise the raw string is shown as inert
// text so a non-JSON (or malicious) body is never fed to the highlighter or v-html.
function tryPrettyJson(src: string): string | null {
  try {
    return JSON.stringify(JSON.parse(src), null, 2);
  } catch {
    return null;
  }
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}
function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtUptime(since: number): string {
  let s = Math.max(0, Math.floor((now.value - since) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function compact(f: Frame): string {
  const s = JSON.stringify(f);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}
</script>

<template>
  <div class="debug">
    <h1>Debug</h1>

    <section class="card sect">
      <header class="head">
        <div class="head-title">Frame stream</div>
        <div class="head-right">
          <span class="lbl">{{ frameRows.length }} buffered</span>
          <button v-if="paused" class="btn" @click="scrollToLatest">Jump to latest</button>
        </div>
      </header>
      <div ref="logEl" class="log" @scroll="onLogScroll">
        <p v-if="!frameRows.length" class="empty">Waiting for frames…</p>
        <div v-for="row in frameRows" :key="row.id" class="frow">
          <button
            type="button"
            class="fline"
            :aria-expanded="expandedFrames.has(row.id)"
            @click="toggleFrame(row.id, row.frame)"
          >
            <span class="ftime">[{{ fmtClock(row.at) }}]</span>
            <span class="ftype">{{ row.type }}</span>
            <span class="fprev">{{ compact(row.frame) }}</span>
          </button>
          <pre v-if="expandedFrames.has(row.id)" class="hljs json"><code v-html="hlStore[`frame:${row.id}`]"></code></pre>
        </div>
      </div>
    </section>

    <section class="card sect">
      <header class="head">
        <div class="head-title">Client list</div>
        <span class="lbl">{{ sub.clients.length }} connected</span>
      </header>
      <p v-if="!sub.clients.length" class="empty">No clients connected.</p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th>IP</th><th>Tier</th><th>Auth</th><th>Uptime</th><th class="ua-col">User agent</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in sub.clients" :key="c.id">
            <td class="mono">{{ c.remoteAddr || "—" }}</td>
            <td><span class="pill" :class="c.tier === 'control' ? 'ind' : 'muted'">{{ c.tier }}</span></td>
            <td class="mono">{{ c.auth }}</td>
            <td class="mono">{{ fmtUptime(c.connectedAt) }}</td>
            <td class="ua">{{ c.userAgent || "—" }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card sect">
      <header class="head">
        <div class="head-title">Webhook Delivery History</div>
        <span class="lbl">{{ webhookRows.length }} recent</span>
      </header>
      <p v-if="!webhookRows.length" class="empty">No deliveries yet.</p>
      <div v-else class="wlist">
        <div v-for="row in webhookRows" :key="row.id" class="wrow">
          <button
            type="button"
            class="wline"
            :aria-expanded="expandedWebhooks.has(row.id)"
            @click="toggleWebhook(row.id, row.delivery)"
          >
            <span class="pill" :class="row.status.cls">{{ row.status.label }}</span>
            <span class="wtype">{{ row.delivery.type }}</span>
            <span class="wurl mono">{{ row.delivery.url }}</span>
            <span class="wtime">{{ row.delivery.durationMs }} ms</span>
            <span class="wat">{{ fmtClock(row.delivery.at) }}</span>
          </button>
          <div v-if="expandedWebhooks.has(row.id)" class="wdetail">
            <p v-if="row.delivery.error" class="werr">{{ row.delivery.error }}</p>
            <div class="wpanel">
              <span class="lbl">Request headers</span>
              <pre class="hljs json"><code v-html="hlStore[`wh:${row.id}:req`]"></code></pre>
            </div>
            <div class="wpanel">
              <span class="lbl">Response headers</span>
              <pre class="hljs json"><code v-html="hlStore[`wh:${row.id}:resp`]"></code></pre>
            </div>
            <div class="wpanel">
              <span class="lbl">Response body</span>
              <pre
                v-if="whBodyJson[row.id]"
                class="hljs json"
              ><code v-html="hlStore[`wh:${row.id}:body`]"></code></pre>
              <pre v-else class="raw">{{ row.delivery.respBody || "—" }}</pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.debug { display: flex; flex-direction: column; gap: 18px; }
.debug h1 { font-family: var(--disp); font-size: 22px; font-weight: 700; letter-spacing: -.015em; margin: 0; }

.sect { padding: 22px; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; gap: 12px; }
.head-title { font-family: var(--disp); font-size: 16px; font-weight: 700; }
.head-right { display: flex; align-items: center; gap: 12px; }

.empty { font-size: 13px; color: var(--faint); padding: 20px 0; text-align: center; margin: 0; }

.log { max-height: 340px; overflow-y: auto; border: 1px solid var(--line2); border-radius: 12px; background: var(--sub); padding: 8px; }
.frow { border-bottom: 1px solid var(--line); }
.frow:last-child { border-bottom: none; }
.fline { display: flex; gap: 8px; align-items: baseline; padding: 4px 6px; cursor: pointer; font-size: 12.5px; width: 100%; text-align: left; background: none; border: none; color: inherit; font-family: inherit; }
.fline:hover { background: var(--ind-s); border-radius: 6px; }
.fline:focus-visible { outline: 2px solid var(--ind); outline-offset: -2px; border-radius: 6px; }
.ftime { color: var(--faint); font-family: var(--disp); font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.ftype { color: var(--ind); font-weight: 600; flex: 0 0 auto; }
.fprev { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.json { margin: 4px 6px 10px; border: 1px solid var(--line2); border-radius: 10px; padding: 12px; overflow: auto; font-size: 12.5px; }
.raw { margin: 4px 0 0; border: 1px solid var(--line2); border-radius: 10px; padding: 12px; overflow: auto; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; color: var(--txt); background: var(--sub); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--faint); padding: 6px 10px; border-bottom: 1px solid var(--line); }
.tbl td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.tbl tr:last-child td { border-bottom: none; }
.ua-col { width: 40%; }
.ua { color: var(--dim); word-break: break-word; }

.wlist { display: flex; flex-direction: column; gap: 10px; }
.wrow { border: 1px solid var(--line); border-radius: 12px; background: var(--sub); overflow: hidden; }
.wline { display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; font-size: 13px; width: 100%; text-align: left; background: none; border: none; color: inherit; font-family: inherit; }
.wline:hover { background: var(--ind-s); }
.wline:focus-visible { outline: 2px solid var(--ind); outline-offset: -2px; }
.wtype { font-weight: 600; flex: 0 0 auto; }
.wurl { color: var(--dim); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtime { color: var(--faint); flex: 0 0 auto; }
.wat { color: var(--faint); font-family: var(--disp); font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.wdetail { padding: 0 12px 12px; border-top: 1px solid var(--line); }
.wpanel { margin-top: 12px; }
.wpanel .lbl { display: block; margin-bottom: 6px; }
.werr { color: var(--bad); font-size: 13px; font-weight: 600; margin: 12px 0 0; }

.pill.ok { background: var(--ok-s); color: var(--ok); }
.pill.bad { background: var(--bad-s); color: var(--bad); }
.pill.warn { background: var(--warn-s); color: var(--warn); }
.pill.ind { background: var(--ind-s); color: var(--ind); }
.pill.muted { background: var(--sub); color: var(--dim); }
</style>
