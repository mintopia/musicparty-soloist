import { reactive, ref, computed } from "vue";

// Masked config: sections of key -> value; a set secret masks to `true`.
export type Config = Record<string, Record<string, unknown>>;
export interface Summary {
  pendingRestart?: boolean;
  [k: string]: unknown;
}
type SaveStatus = "idle" | "saving" | "saved";

// The maskConfig contract masks only these fields to a boolean `true` when set; every
// other config value is passed through verbatim. Flagging any `=== true` value as a
// secret would mislabel genuine booleans, so match this fixed list (mirrors src/web).
const SECRET_FIELDS: [string, string][] = [
  ["soloist", "apiKey"], ["proxy", "token"], ["webhooks", "secret"],
  ["relay", "authorization"], ["web", "password"],
];

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (!res.ok) throw new Error(`${opts?.method || "GET"} ${path} -> ${res.status}`);
  return res.json();
}

// Module-level singleton: the topbar save bar, restart banner, and the Settings view
// all read one working copy. No Pinia (ADR-0014) — a shared reactive object suffices.
const config = reactive<Config>({});
const saved = ref<string>("{}"); // JSON snapshot of the last loaded/saved state
const summary = reactive<Summary>({});
const secretSet = reactive<Record<string, boolean>>({});
const status = ref<SaveStatus>("idle");
const loaded = ref(false);

const dirty = computed(() => JSON.stringify(config) !== saved.value);

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

async function load() {
  const [cfg, sum] = await Promise.all([api("/api/config"), api("/api/config-summary")]);
  replace(config, cfg);
  saved.value = JSON.stringify(cfg);
  Object.assign(summary, sum);
  deriveSecrets(cfg);
  status.value = "idle";
  loaded.value = true;
}

async function save() {
  status.value = "saving";
  const updated = await api("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  replace(config, updated);
  saved.value = JSON.stringify(updated);
  deriveSecrets(updated);
  status.value = "saved";
  setTimeout(() => { if (status.value === "saved") status.value = "idle"; }, 1200);
  await refreshSummary();
}

async function discard() {
  const cfg = await api("/api/config");
  replace(config, cfg);
  saved.value = JSON.stringify(cfg);
  deriveSecrets(cfg);
  status.value = "idle";
}

async function refreshSummary() {
  Object.assign(summary, await api("/api/config-summary"));
}

async function restartSoloist() {
  await api("/api/restart-soloist", { method: "POST" });
  await refreshSummary();
}

// Fetch one allowlisted secret's plaintext for the reveal toggle (server 404s any
// key outside REVEALABLE). Kept here so all config API calls share the `api` helper.
async function revealSecret(section: string, key: string): Promise<string> {
  const r = await api(`/api/secret?section=${encodeURIComponent(section)}&key=${encodeURIComponent(key)}`);
  return r.value as string;
}

export function useConfig() {
  return { config, summary, secretSet, dirty, status, loaded, load, save, discard, refreshSummary, restartSoloist, revealSecret };
}
