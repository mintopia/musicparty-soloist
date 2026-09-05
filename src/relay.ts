// A persistent outbound WS bridge to a single Relay Server (ADR-0012): republishes
// every Soloist->downstream frame verbatim, and forwards every received frame raw to
// the upstream Soloist socket (full control). Reconnects with backoff while a url is
// configured; re-dials live when url/authorization changes (apply()).

import { WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";
import type { SoloistHub } from "./hub.js";
import { deferred } from "./util.js";
import { reconnectLoop } from "./reconnect.js";
import { makeLog } from "./log.js";
import type { RelayStatus } from "./wire-contract.js";

const log = makeLog("relay");

const RELAY_BACKOFF_BASE = 0.5;
const RELAY_BACKOFF_MAX = 30.0;

export type { RelayStatus } from "./wire-contract.js";

export class SoloistRelay {
  private conn: WebSocket | null = null;
  private stopped = false;
  private wake = deferred();
  private appliedUrl: string;
  private appliedAuth: string;
  readonly status: RelayStatus = { enabled: false, connected: false, lastConnectAt: null, lastError: null };

  constructor(hub: SoloistHub, private cfg: Config) {
    this.appliedUrl = cfg.relay.url;
    this.appliedAuth = cfg.relay.authorization;
    // Outbound: mirror what a Downstream Client observes, unfiltered, verbatim.
    hub.observe((frame) => {
      const c = this.conn;
      if (c && c.readyState === WebSocket.OPEN) c.send(frame.raw);
    });
    // Inbound: raw bytes straight upstream, transparent — the Relay Server is a
    // full-control peer.
    this.onMessage = (data, isBinary) => hub.sendUpstream(data, isBinary);
  }

  private onMessage: (data: RawData, isBinary: boolean) => void;

  private signal(): void {
    this.wake.resolve();
    this.wake = deferred();
  }

  // Re-dial only if url/authorization actually changed, so an unrelated config save
  // never needlessly drops a healthy relay connection.
  apply(): void {
    if (this.cfg.relay.url === this.appliedUrl && this.cfg.relay.authorization === this.appliedAuth) return;
    this.appliedUrl = this.cfg.relay.url;
    this.appliedAuth = this.cfg.relay.authorization;
    this.conn?.close();
    this.signal();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
    this.signal();
  }

  async run(): Promise<void> {
    // Resolved fresh in connect() (not hoisted) so it always reflects the url used to
    // open the connection this iteration, even if apply() changes it mid-loop.
    let currentUrl = "";
    await reconnectLoop({
      backoffBase: RELAY_BACKOFF_BASE,
      backoffMax: RELAY_BACKOFF_MAX,
      isStopped: () => this.stopped,
      getWake: () => this.wake,
      shouldDial: () => {
        const url = this.cfg.relay.url;
        this.status.enabled = url !== "";
        if (!url) {
          this.status.connected = false;
          return false; // park until apply()/stop()
        }
        return true;
      },
      connect: () => {
        currentUrl = this.cfg.relay.url;
        const headers: Record<string, string> = {};
        if (this.cfg.relay.authorization) headers.authorization = this.cfg.relay.authorization;
        return new WebSocket(currentUrl, { headers });
      },
      onOpen: (conn) => {
        log("relay connected to %s", currentUrl);
        this.conn = conn;
        this.status.connected = true;
        this.status.lastConnectAt = Date.now();
        this.status.lastError = null;
      },
      onMessage: (data, isBinary) => this.onMessage(data, isBinary),
      onError: (err) => {
        this.status.lastError = err.message;
        log.error("relay %s error: %s", currentUrl, err.message);
      },
      onSettled: () => {
        this.conn = null;
        this.status.connected = false;
      },
    });
  }
}
