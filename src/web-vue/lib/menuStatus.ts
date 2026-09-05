// Framework-free status derivation for the Menu (ADR-0014 lib seam). The worst-of badge
// precedence (ADR-0017) lives here as pure functions so it is unit-tested headless; the Vue
// component only feeds reactive inputs in.

import type { RelayStatus } from "../../wire-contract";

export type BadgeLevel = "green" | "amber" | "red";

export interface SoloistStatus {
  state: string | null;
  upstream: boolean;
  loggedIn: boolean | null;
}

// Supervisor states in which the Soloist process is not running or is broken; transient
// start-up states (waiting/acquiring/starting) are deliberately not "down".
export const SOLOIST_DOWN_STATES: readonly string[] = ["stopped", "backoff", "expired-reacquiring"];

export function soloistDown(s: SoloistStatus | null): boolean {
  return s != null && s.state != null && SOLOIST_DOWN_STATES.includes(s.state);
}

export function waitingForLogin(s: SoloistStatus | null): boolean {
  return s != null && s.upstream === true && s.loggedIn === false;
}

export function relayDegraded(r: RelayStatus | null): boolean {
  return r != null && r.enabled && !r.connected;
}

// appLive is false when the App-Control socket is closed or its proxy_status has aged out:
// nothing derived from proxy_status can be trusted, so the Soloist line reads red/unknown.
export function soloistLevel(s: SoloistStatus | null, appLive: boolean, dataConnected: boolean): BadgeLevel {
  if (!appLive || !dataConnected || soloistDown(s)) return "red";
  if (waitingForLogin(s)) return "amber";
  return "green";
}

export function relayLevel(r: RelayStatus | null, appLive: boolean): BadgeLevel {
  return appLive && relayDegraded(r) ? "amber" : "green";
}

export function webhookLevel(webhookOk: boolean | null, appLive: boolean): BadgeLevel {
  return appLive && webhookOk === false ? "amber" : "green";
}

export function soloistText(s: SoloistStatus | null, appLive: boolean, dataConnected: boolean): string {
  if (!appLive) return "Unknown";
  if (!dataConnected) return "Disconnected";
  if (soloistDown(s)) return "Down";
  if (waitingForLogin(s)) return "Waiting for login";
  if (s != null && s.upstream && s.loggedIn === true) return "Logged in";
  return "Starting…";
}

const RANK: Record<BadgeLevel, number> = { green: 0, amber: 1, red: 2 };

export function worstBadge(levels: BadgeLevel[]): BadgeLevel {
  return levels.reduce<BadgeLevel>((worst, l) => (RANK[l] > RANK[worst] ? l : worst), "green");
}

export interface BadgeInput {
  appLive: boolean;
  dataConnected: boolean;
  soloist: SoloistStatus | null;
  relay: RelayStatus | null;
  webhookOk: boolean | null;
}

export function badgeLevel(i: BadgeInput): BadgeLevel {
  return worstBadge([
    soloistLevel(i.soloist, i.appLive, i.dataConnected),
    relayLevel(i.relay, i.appLive),
    webhookLevel(i.webhookOk, i.appLive),
  ]);
}
