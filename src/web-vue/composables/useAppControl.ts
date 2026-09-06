import { reactive, ref, type Ref } from "vue";
import type { DebugStream, ProxyStatus, ClientMeta, WebhookDelivery } from "../../wire-contract";

export type { DebugStream, ProxyStatus, ClientMeta, WebhookDelivery };

export type Frame = Record<string, unknown>;

export interface AppControlSubscription {
  frames: Frame[];
  clients: ClientMeta[];
  webhooks: WebhookDelivery[];
  dispose: () => void;
}

// Minimal socket shape both the browser WebSocket and a test fake satisfy, so the transport
// is injectable without pulling a DOM dependency into the tests.
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface AppControlOptions {
  url?: string;
  socketFactory?: (url: string) => WebSocketLike;
  staleMs?: number;
  frameRing?: number;
  webhookRing?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const WS_OPEN = 1; // WebSocket.OPEN, inlined so this module needs no DOM global at load time.
const APP_CONTROL_PATH = "/ws/app";

interface Sub {
  streams: Set<DebugStream>;
  frames: Frame[];
  clients: ClientMeta[];
  webhooks: WebhookDelivery[];
}

function defaultUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${APP_CONTROL_PATH}`;
}

function pushRing<T>(buf: T[], item: T, cap: number): void {
  buf.push(item);
  if (buf.length > cap) buf.splice(0, buf.length - cap);
}

function replaceAll<T>(buf: T[], next: T[]): void {
  buf.splice(0, buf.length, ...next);
}

export function createAppControl(opts: AppControlOptions = {}) {
  const staleMs = opts.staleMs ?? 10000;
  const frameRing = opts.frameRing ?? 200;
  const webhookRing = opts.webhookRing ?? 200;
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const backoffMaxMs = opts.backoffMaxMs ?? 15000;
  const makeSocket = opts.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const resolveUrl = () => opts.url ?? defaultUrl();

  const status = ref<ProxyStatus | null>(null);
  const connected = ref(false);
  // Starts stale: nothing is green until a fresh proxy_status arrives. Set true on every
  // disconnect and whenever the heartbeat ages out, so status never lingers green while blind.
  const stale = ref(true);

  const subs = new Set<Sub>();
  // Retained master buffers, kept current for the life of the singleton by every message the
  // socket receives — even with no live consumer, since this shared socket stays subscribed
  // across page visits (dispose() never unsubscribes). A subscribe() seeds its fresh buffers
  // from these, so a Debug Page reopened via client-side nav paints from the last-known
  // snapshot instead of empty: the server won't re-seed an already-subscribed stream
  // (idempotent subscribe, appcontrol.ts), so without this the reopened buffers stay blank
  // until the next live event.
  const masterFrames: Frame[] = [];
  const masterClients: ClientMeta[] = [];
  const masterWebhooks: WebhookDelivery[] = [];
  let ws: WebSocketLike | null = null;
  let backoffMs = backoffBaseMs;
  let started = false;
  let lastStatusAt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  // proxy_status is always in the set so app-wide status flows even with zero consumers.
  function neededStreams(): DebugStream[] {
    const set = new Set<DebugStream>(["proxy_status"]);
    for (const s of subs) for (const st of s.streams) set.add(st);
    return [...set];
  }

  // Re-sending the full set is safe: the server's subscribe is idempotent (a stream already
  // subscribed re-seeds nothing), so this doubles as the on-reconnect resubscribe.
  function sendSubscribe(): void {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "subscribe", streams: neededStreams() }));
  }

  function applyStatus(s: ProxyStatus): void {
    status.value = s;
    lastStatusAt = Date.now();
    stale.value = false;
  }

  function onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const { stream, data } = msg as { stream?: unknown; data?: unknown };
    if (typeof stream !== "string") return;
    if (stream === "proxy_status") {
      applyStatus(data as ProxyStatus);
      return;
    }
    if (stream === "frame") {
      pushRing(masterFrames, data as Frame, frameRing);
      for (const sub of subs) if (sub.streams.has("frame")) pushRing(sub.frames, data as Frame, frameRing);
    } else if (stream === "clients") {
      replaceAll(masterClients, data as ClientMeta[]);
      for (const sub of subs) if (sub.streams.has("clients")) replaceAll(sub.clients, data as ClientMeta[]);
    } else if (stream === "webhooks") {
      // On-subscribe dump is the full history array; live deliveries arrive one at a time.
      // The dump is ring-capped too, so a large history can never exceed the buffer bound.
      if (Array.isArray(data)) {
        const dump = (data as WebhookDelivery[]).slice(-webhookRing);
        replaceAll(masterWebhooks, dump);
        for (const sub of subs) if (sub.streams.has("webhooks")) replaceAll(sub.webhooks, dump);
      } else {
        pushRing(masterWebhooks, data as WebhookDelivery, webhookRing);
        for (const sub of subs) if (sub.streams.has("webhooks")) pushRing(sub.webhooks, data as WebhookDelivery, webhookRing);
      }
    }
  }

  function connect(): void {
    reconnectTimer = null;
    const socket = makeSocket(resolveUrl());
    ws = socket;
    // Every handler guards `ws === socket`, so a late event from a socket we've already
    // discarded on reconnect can never mutate live state — no stale-listener leak.
    socket.onopen = () => {
      if (ws !== socket) return;
      connected.value = true;
      backoffMs = backoffBaseMs;
      sendSubscribe();
    };
    socket.onmessage = (ev) => {
      if (ws === socket) onMessage(ev.data);
    };
    socket.onerror = () => {
      if (ws !== socket) return;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      connected.value = false;
      stale.value = true;
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
  }

  // Age out status if the heartbeat stops arriving while still nominally connected, so a
  // wedged-but-open socket never leaves status green.
  function checkStale(): void {
    if (connected.value && lastStatusAt > 0 && Date.now() - lastStatusAt > staleMs) stale.value = true;
  }

  // Idempotent: the app shell calls start() once; subscribe() also calls it so a Debug Page
  // works even if the shell hasn't.
  function start(): void {
    if (started) return;
    started = true;
    watchdog = setInterval(checkStale, Math.max(1, Math.min(staleMs, 2000)));
    connect();
  }

  function subscribe(streams: DebugStream[]): AppControlSubscription {
    // Seed from the retained master so a reopened Debug Page paints immediately (see the
    // master-buffer note above) instead of waiting on a server re-seed that won't come.
    const sub: Sub = {
      streams: new Set(streams),
      frames: reactive<Frame[]>([...masterFrames]),
      clients: reactive<ClientMeta[]>([...masterClients]),
      webhooks: reactive<WebhookDelivery[]>([...masterWebhooks]),
    };
    subs.add(sub);
    start();
    sendSubscribe();
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      subs.delete(sub);
    };
    return { frames: sub.frames, clients: sub.clients, webhooks: sub.webhooks, dispose };
  }

  function stop(): void {
    started = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    const socket = ws;
    ws = null;
    connected.value = false;
    stale.value = true;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }

  return {
    status: status as Ref<ProxyStatus | null>,
    connected: connected as Ref<boolean>,
    stale: stale as Ref<boolean>,
    subscribe,
    start,
    stop,
  };
}

export type AppControl = ReturnType<typeof createAppControl>;

let shared: AppControl | null = null;

export function useAppControl(): AppControl {
  return (shared ??= createAppControl());
}
