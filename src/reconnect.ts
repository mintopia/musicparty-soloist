// Reconnect-with-backoff driver shared by SoloistHub.run and SoloistRelay.run: both dial
// a WebSocket, wait out open/message/error/close, then sleep-with-early-wake and grow the
// backoff. The owner keeps its own stopped/wake/conn state; this only drives the loop shape,
// so each caller's connect/lifecycle specifics stay in its own class.

import { setTimeout as sleep } from "node:timers/promises";
import type { WebSocket, RawData } from "ws";

export interface ReconnectLoopOptions {
  backoffBase: number;
  backoffMax: number;
  isStopped(): boolean;
  // Must read the owner's *current* wake handle, not a cached one: the owner replaces it
  // on every apply()/stop() signal, so a stale reference would never resolve.
  getWake(): { promise: Promise<void> };
  // Return false to skip dialing this iteration and park on wake instead — no backoff
  // change — used by the Relay while no url is configured.
  shouldDial(): boolean;
  connect(): WebSocket;
  onOpen(conn: WebSocket): void;
  onMessage(data: RawData, isBinary: boolean): void;
  onError(err: Error): void;
  onSettled(): void;
  onReconnectWait?(backoffSeconds: number): void;
}

export async function reconnectLoop(opts: ReconnectLoopOptions): Promise<void> {
  let backoff = opts.backoffBase;
  while (!opts.isStopped()) {
    if (!opts.shouldDial()) {
      await opts.getWake().promise;
      continue;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const conn = opts.connect();
        conn.on("open", () => {
          opts.onOpen(conn);
          backoff = opts.backoffBase;
        });
        conn.on("message", (data, isBinary) => opts.onMessage(data, isBinary));
        conn.on("error", (err) => reject(err));
        conn.on("close", () => resolve());
      });
    } catch (err) {
      opts.onError(err as Error);
    } finally {
      opts.onSettled();
    }
    if (opts.isStopped()) break;
    opts.onReconnectWait?.(backoff);
    // Backoff, but wake early on the owner's apply()/stop() so shutdown/reconfig never
    // waits out the cap.
    await Promise.race([sleep(backoff * 1000), opts.getWake().promise]);
    backoff = Math.min(backoff * 2, opts.backoffMax);
  }
}
