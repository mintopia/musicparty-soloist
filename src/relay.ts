// A persistent outbound WS bridge to a single Relay Server (ADR-0012): republishes
// every Soloist->downstream frame verbatim, and forwards every received frame raw to
// the upstream Soloist socket (full control). Reconnects with backoff while a url is
// configured; re-dials live when url/authorization changes (apply()).

import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";
import type { SoloistHub } from "./hub.js";
import { deferred } from "./util.js";
import { makeLog } from "./log.js";

const log = makeLog("proxy");

const RELAY_BACKOFF_BASE = 0.5;
const RELAY_BACKOFF_MAX = 30.0;

export interface RelayStatus {
  enabled: boolean;         // url configured
  connected: boolean;
  lastConnectAt: number | null;
  lastError: string | null;
}

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
    let backoff = RELAY_BACKOFF_BASE;
    while (!this.stopped) {
      const url = this.cfg.relay.url;
      this.status.enabled = url !== "";
      if (!url) {
        this.status.connected = false;
        await this.wake.promise; // park until apply()/stop()
        continue;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const headers: Record<string, string> = {};
          if (this.cfg.relay.authorization) headers.authorization = this.cfg.relay.authorization;
          const conn = new WebSocket(url, { headers });
          conn.on("open", () => {
            log("relay connected to %s", url);
            this.conn = conn;
            this.status.connected = true;
            this.status.lastConnectAt = Date.now();
            this.status.lastError = null;
            backoff = RELAY_BACKOFF_BASE;
          });
          conn.on("message", (data, isBinary) => this.onMessage(data, isBinary));
          conn.on("error", (err) => reject(err));
          conn.on("close", () => resolve());
        });
      } catch (err) {
        this.status.lastError = (err as Error).message;
        log("relay %s error: %s", url, (err as Error).message);
      } finally {
        this.conn = null;
        this.status.connected = false;
      }
      if (this.stopped) break;
      // Backoff, but wake early on apply()/stop().
      await Promise.race([sleep(backoff * 1000), this.wake.promise]);
      backoff = Math.min(backoff * 2, RELAY_BACKOFF_MAX);
    }
  }
}
