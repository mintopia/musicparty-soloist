import { reactive, ref, computed } from "vue";

export type Config = Record<string, Record<string, unknown>>;
export interface Summary {
  pendingRestart?: boolean;
  [k: string]: unknown;
}
type SaveStatus = "idle" | "saving" | "saved" | "error";

// The maskConfig contract masks only these fields to a boolean `true` when set; every
// other config value is passed through verbatim. Flagging any `=== true` value as a
// secret would mislabel genuine booleans, so match this fixed list (mirrors src/web).
const SECRET_FIELDS: [string, string][] = [
  ["soloist", "apiKey"], ["proxy", "token"], ["webhooks", "secret"],
  ["relay", "authorization"], ["web", "password"],
];

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (!res.ok) throw new Error(await apiError(res, opts?.method));
  return res.json();
}

// Prefer the server's { error } message (e.g. a rejected config value) so a failed save
// can tell the user why; fall back to the method + status when the body isn't that shape.
async function apiError(res: Response, method?: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch { /* non-JSON error body */ }
  return `${method || "GET"} failed (${res.status})`;
}

const config = reactive<Config>({});
const saved = ref<string>("{}");
const summary = reactive<Summary>({});
const secretSet = reactive<Record<string, boolean>>({});
const status = ref<SaveStatus>("idle");
const error = ref<string>("");
const loaded = ref(false);

const dirty = computed(() => JSON.stringify(config) !== saved.value);

const dirtyCount = computed(() => {
  let prevCfg: Config;
  try { prevCfg = JSON.parse(saved.value) as Config; } catch { return 0; }
  let n = 0;
  for (const section of new Set([...Object.keys(config), ...Object.keys(prevCfg)])) {
    const cur = config[section] ?? {};
    const prev = prevCfg[section] ?? {};
    for (const key of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
      if (JSON.stringify(cur[key]) !== JSON.stringify(prev[key])) n++;
    }
  }
  return n;
});

// Guard tab-close / back-nav / hard reload while edits are unsaved (UX-H3): without this
// the working copy vanishes with no prompt. Reads the shared dirty flag so it tracks the
// singleton live; setting returnValue is what triggers the browser's native confirm.
export function beforeUnloadGuard(e: BeforeUnloadEvent) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = "";
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", beforeUnloadGuard);
}

function replace(target: Config, next: Config) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}

function deriveSecrets(cfg: Config) {
  for (const k of Object.keys(secretSet)) delete secretSet[k];
  for (const [section, key] of SECRET_FIELDS) {
    secretSet[`${section}.${key}`] = cfg[section]?.[key] === true;
  }
}

let loadPromise: Promise<void> | null = null;
function load() {
  if (!loadPromise) loadPromise = doLoad().catch((e) => { loadPromise = null; throw e; });
  return loadPromise;
}

async function doLoad() {
  const [cfg, sum] = await Promise.all([api("/api/config"), api("/api/config-summary")]);
  replace(config, cfg);
  saved.value = JSON.stringify(cfg);
  Object.assign(summary, sum);
  deriveSecrets(cfg);
  status.value = "idle";
  loaded.value = true;
}

// On any failure below, land in "error" (never "saving") with a message so the save bar
// shows what went wrong and re-enables Save/Discard for a retry, rather than hanging with
// the user's edits seemingly in-flight (UX-C1).
function fail(prefix: string, e: unknown) {
  status.value = "error";
  const msg = (e as Error)?.message;
  error.value = msg ? `${prefix} — ${msg}` : `${prefix} — retry`;
}

// Clear a lingering error once the action that set it succeeds, so a resolved failure
// (e.g. a retried restart) doesn't leave the save bar showing a stale red message.
function clearError() {
  if (status.value === "error") { status.value = "idle"; error.value = ""; }
}

async function save() {
  status.value = "saving";
  error.value = "";
  let updated: Config;
  try {
    updated = await api("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch (e) {
    fail("Save failed", e);
    return;
  }
  replace(config, updated);
  saved.value = JSON.stringify(updated);
  deriveSecrets(updated);
  status.value = "saved";
  setTimeout(() => { if (status.value === "saved") status.value = "idle"; }, 1200);
  // Best-effort: the save already succeeded, so a summary refresh failure must not reject
  // the (unhandled) save() call nor flip the bar back to an error.
  await refreshSummary().catch(() => {});
}

async function discard() {
  try {
    const cfg = await api("/api/config");
    replace(config, cfg);
    saved.value = JSON.stringify(cfg);
    deriveSecrets(cfg);
    status.value = "idle";
    error.value = "";
  } catch (e) {
    fail("Discard failed", e);
  }
}

function trySave() {
  if (dirty.value && status.value !== "saving") save();
}

async function refreshSummary() {
  Object.assign(summary, await api("/api/config-summary"));
}

async function restartSoloist() {
  try {
    await api("/api/restart-soloist", { method: "POST" });
    await refreshSummary();
    clearError();
  } catch (e) {
    fail("Restart failed", e);
  }
}

async function restartSnapcast() {
  try {
    await api("/api/restart-snapcast", { method: "POST" });
    await refreshSummary();
    clearError();
  } catch (e) {
    fail("Snapcast restart failed", e);
  }
}

async function revealSecret(section: string, key: string): Promise<string> {
  const r = await api(`/api/secret?section=${encodeURIComponent(section)}&key=${encodeURIComponent(key)}`);
  return r.value as string;
}

export function useConfig() {
  return { config, summary, secretSet, dirty, dirtyCount, status, error, loaded, load, save, discard, trySave, refreshSummary, restartSoloist, restartSnapcast, revealSecret };
}
