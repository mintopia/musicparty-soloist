// Single source of truth for the JSON shapes crossing the Proxy↔browser boundary
// (App-Control diagnostics + downstream status). ADR-0014's buildless split gives the
// server and web-vue client separate tsconfigs, so a hand-copied type on either side can
// drift silently. Keeping the wire contract here — type/const only, no runtime imports —
// lets both the NodeNext server config and the Bundler web-vue config compile it unchanged,
// so a field rename or a new stream breaks the build instead of the wire.

// The supervisor loop's transient phase, surfaced for the Menu's Soloist status.
export type SoloistState =
  | "waiting"
  | "acquiring"
  | "starting"
  | "running"
  | "backoff"
  | "expired-reacquiring"
  | "stopped";

export type ClientAuth = "auth-token" | "readonly-token" | "session-cookie";

export interface RelayStatus {
  enabled: boolean; // url configured
  connected: boolean;
  lastConnectAt: number | null;
  lastError: string | null;
}

// Compact status snapshot (buildProxyStatus): the webhook field is a summary only —
// full delivery detail rides the separate `webhooks` stream.
export interface ProxyStatus {
  soloist: { state: SoloistState | null; upstream: boolean; loggedIn: boolean | null };
  clients: number;
  relay: RelayStatus;
  webhook: { at: number; type: string; status: number | null; ok: boolean } | null;
}

export interface ClientMeta {
  id: string;
  remoteAddr: string;
  tier: "control" | "readonly";
  auth: ClientAuth;
  connectedAt: number;
  userAgent: string;
}

export interface WebhookDelivery {
  at: number; // start of the delivery attempt, not when it was recorded
  type: string;
  url: string;
  status: number | null; // null on network/timeout error (no response)
  durationMs: number;
  reqHeaders: Record<string, string>; // authorization redacted to "Bearer ***"
  respHeaders: Record<string, string>; // allowlisted only, lowercase keys
  respBody: string; // capped to WEBHOOK_RESP_BODY_CAP bytes, "…[truncated]" if it overflowed
  error: string | null;
}

// The fixed set of App-Control diagnostic streams a Debug Subscriber may subscribe to.
// proxy_status is subscribed implicitly; the rest are opt-in. Client and server both
// derive DebugStream from this one list.
export const DEBUG_STREAMS = ["frame", "clients", "webhooks", "proxy_status"] as const;
export type DebugStream = (typeof DEBUG_STREAMS)[number];
