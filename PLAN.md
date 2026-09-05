# Plan: Menu + Debug Page + live status

_Locked via grill-with-docs — by Claude + Jess. Terms per CONTEXT.md._

## Goal

Add a top-right **Menu** to the Landing Page (light/dark toggle, Debug Page link, logout,
and live status entries for Soloist, Client Count, Relay, and Webhook Status, with a
worst-of-state badge on the trigger), a new **Debug Page** (live Soloist frame stream,
connected Downstream Client list, and Webhook Delivery History — all JSON syntax-
highlighted), and a **Client Count** metric. All operator telemetry travels on a new,
session-gated **App-Control WebSocket**; the **Soloist data stream (`/`) stays pure**
(Soloist frames verbatim, auth only) — no `proxy_status` is ever injected there.

## Approach

### Backend (`src/`)

1. **Hub client metadata (`proxy.ts`).** Replace `clients: Set<WebSocket>` with a
   `Map<WebSocket, ClientMeta>` (`{ id, remoteAddr, tier, auth, connectedAt, userAgent }`).
   `register(client, meta)` records it; `broadcast`/`forward` iterate keys; drop the
   `readonlyClients` WeakSet in favor of `meta.tier === 'readonly'`. Add `clientCount()`
   and `clientList()`. The upgrade handler derives meta from the request: `remoteAddr` from
   `req.socket.remoteAddress`, `tier` from `checkAuth`, `userAgent` from `req.headers`.
   **`auth` is a closed enum `'auth-token' | 'readonly-token' | 'session-cookie'` derived
   from the successful `checkAuth` branch — the raw `presentedToken()` value is NEVER
   stored or exposed** (Codex #1: it returns the literal token).

2. **Hub status getters (`proxy.ts`).** `get upstreamConnected()` (conn OPEN) and
   `loggedIn(): boolean | null` = `null` when `!upstreamConnected` (unknown), else
   `latestState.get('auth_state')?.message.logged_in === true`. **Do not clear
   `latestState` on disconnect** — its replay-to-new-clients role is unchanged; the `null`
   is derived, not stored (Codex #11: avoids `upstream:false, loggedIn:true`).

3. **Supervisor status (`supervisor.ts`/`SoloistControl`).** The supervisor loop is a
   transient state machine (waiting-for-config → acquire → start → run → on exit: code 10 ⇒
   re-acquire, else backoff+restart). Add a `state` field updated at each existing boundary
   and expose `soloistStatus(): { state: 'waiting'|'acquiring'|'starting'|'running'|'backoff'|'expired-reacquiring'|'stopped' }`
   (Codex #10 — `expired`/`exited` alone are stale/transient). The Menu maps these to
   Down / Waiting-for-login / Logged-in together with the Hub link + login state.

4. **Webhook Delivery History (`webhooks.ts`).** Replace `WebhookStats` (per-URL aggregate)
   with a `WebhookHistory` ring buffer (cap 10) of `WebhookDelivery`
   `{ at, type, url, status, durationMs, reqHeaders(redacted), respHeaders(redacted), respBody(capped ~8KB, truncation marker), error }`.
   `postWebhook`: record start time, status, duration; **read `res.body` incrementally up to
   the byte cap and cancel the reader** — never `res.text()` (Codex #3: it buffers the whole
   body). Redact **request** `authorization` → `Bearer ***`. For **response** headers, keep a
   **fixed allowlist** of non-credential headers (`content-type`, `content-length`, `date`,
   `server`, `content-encoding`, `etag`, `cache-control`, `age`, `vary`) and **omit every
   other header** — a denylist can't cover arbitrary secret-bearing headers like
   `x-api-key` / `x-auth-token` / vendor signatures (Codex R2 #4). Expose `entries()`,
   `last()`, and `onEntry(cb)` **returning an idempotent disposer** (Codex #8). `attachWebhooks`
   returns the history.

5. **App-Control WebSocket (`proxy.ts` upgrade routing).** Branch `server.on('upgrade')` on
   path: `APP_CONTROL_PATH` (e.g. `/ws/app`) → require `sessionUser(req, cfg)` **and**
   `sameOrigin(req)`; register a **Debug Subscriber** (separate set, **not** `hub.register`),
   on its **own `WebSocketServer` with a small `maxPayload`** (Codex #9). All other paths →
   existing Downstream Client flow (now with metadata). Debug Subscribers: receive
   `proxy_status` always; on `{type:'subscribe', streams:[…]}` also receive `frame` (mirror
   of `hub.observe` raw Soloist frames — output only), `clients` (list + on connect/
   disconnect), and `webhook` (history dump + `onEntry`). Inbound: **reject binary/malformed
   frames safely, validate `streams` against a fixed set, make subscribe idempotent** (no
   duplicate listeners). They never forward upstream and are never counted.

   - **Auth is revalidated after upgrade** (Codex #6): each socket stores a one-way
     fingerprint (hash) of its session cookie at upgrade, carries a bounded max lifetime, and
     periodically re-checks `sessionUser` against live config, closing on session expiry /
     password rotation. `POST /logout` closes every App-Control socket whose fingerprint
     matches the requesting cookie **before** clearing it (Codex R2 #6 — the plan must define
     the request↔socket association, not hand-wave "close that browser's socket"). Otherwise
     a socket exposing IPs + third-party response bodies outlives its session.
   - **Backpressure** (Codex #7): before every diagnostic send, check `ws.bufferedAmount`;
     drop `frame` updates (and, past a hard threshold, close the subscriber) so a slow/
     backgrounded browser cannot grow server memory unbounded. The client-side 200-frame
     ring does not bound the server.

6. **`proxy_status` broadcaster (`proxy.ts`).** `setInterval` (~3s) in `makeServer` builds
   `{ soloist:{state,upstream,loggedIn}, clients, relay: relay.status, webhook: <compact> }`
   where the webhook field is **only `{ at, status, ok, type }`** — never headers or body
   (Codex #2; matches ADR-0017's narrow Webhook Status). Full detail travels solely on the
   subscribed `webhook` stream. Push eagerly on client connect/disconnect too. Sends to
   Debug Subscribers only — **never** `hub.broadcastMessage` (that is the `/` stream).

7. **`web.ts` cleanup + lifecycle.** Add `/debug` to `APP_PATHS`. Remove `webhooksView` + the
   `/api/webhooks` route (config comes from `/api/config`; stats now live on the App-Control
   WS). Drop the now-unused `stats` param threaded through `handleWebRequest`. **Extend
   `RunningProxy.close()`** to clear the status interval, dispose observer subscriptions,
   terminate Debug Subscriber sockets, and await the App-Control `WebSocketServer` close
   (Codex #12). **`sameOrigin` stays host-only, deliberately** (Codex R2 #5): the server is
   plain `createServer`, so any TLS terminates at a reverse proxy and there is no reliable
   socket scheme to compare; forcing scheme-awareness would reject legitimate HTTPS origins.
   Host-only is sufficient for the CSWSH threat it defends — a cross-site attacker's Origin
   host never matches ours regardless of scheme — and the App-Control socket is additionally
   gated by the HttpOnly, SameSite=Lax session cookie. (Unchanged from today; the earlier
   "scheme-aware" idea is dropped as unimplementable here.)

### Frontend (`src/web-vue/`)

8. **`useAppControl` composable (new).** Opens `/ws/app` app-wide with backoff; exposes
   reactive `status` (latest `proxy_status`), **`connected`** (the App-Control socket's own
   state), and `subscribe(streams)` returning reactive buffers `frames` (ring ~200),
   `clients`, `webhooks` **plus a disposer**. Debug Page subscribes on mount, calls the
   disposer on unmount and on reconnect (Codex #8). On disconnect, `status` is aged out /
   marked stale, not left green (Codex #15).

9. **`AppMenu.vue` (new).** Hamburger with worst-of badge dot; dropdown: theme toggle,
   Debug `RouterLink`, logout `POST /logout`, divider, then status lines from
   `useAppControl` + `usePlayback.state.connected`. Keyboard-accessible + aria +
   click-outside close. Badge precedence: **red/unknown** if the App-Control socket
   (`/ws/app`) is disconnected (status is stale) OR the Soloist data connection is down OR
   the Soloist process is down/expired-reacquiring; **amber** if waiting-for-login, or Relay
   enabled but disconnected, or the last Webhook failed; **green** otherwise. Disconnected/
   unknown always outranks green (Codex #15, ADR-0017).

10. **`App.vue`.** Remove the standalone theme icon button, the logout form, and the WS
    pill; mount `<AppMenu/>`. Keep MiniPlayer + Snapweb. Start `useAppControl` in
    `onMounted`.

11. **`Debug.vue` (new) + route.** Add `/debug` to `router.ts` as a **lazy component import**
    (`component: () => import('./pages/Debug.vue')`) — the current router imports every page
    statically, so this is required for code-splitting (Codex #16). Three sections: frame
    stream (autoscroll log, pause-on-scroll, ~200 buffer), client list table (IP · tier ·
    auth · uptime · UA), Webhook Delivery History (status · timing · req/resp headers ·
    body). JSON via **highlight.js**, with hljs **and its theme CSS both inside the async
    Debug chunk** (ADR-0018); verify against the emitted Vite manifest, not just a clean
    compile.

    - **XSS contract (Codex R2 #17):** webhook response bodies and headers are fully
      attacker-controlled (the destination owns them); frame content is Soloist-controlled.
      All of it must reach the DOM escape-safe: render only via `hljs.highlight(src, …).value`
      (which HTML-escapes its input) into a container, or via Vue text interpolation /
      `textContent` — **never** feed raw response/frame text to `v-html`, and never use
      `hljs.highlightAuto` fallbacks that could pass through unescaped. Test bodies containing
      `<img src=x onerror=alert(1)>` and `</code></pre><script>alert(1)</script>` render as
      inert text on the authenticated operator page.

12. **`Webhooks.vue`.** Remove the delivery-stats display and its `/api/webhooks` fetch —
    config only.

13. **`package.json`.** Add `highlight.js`; dynamic-import core + JSON language in the Debug
    view.

### Tests (`src/selftest.ts`)

14. Update webhook tests to the history model; add tests for: client metadata list shape +
    `auth` enum (never the raw token), webhook capture + request/response header redaction +
    streamed body cap/truncation, the compact `proxy_status` webhook summary (no body/
    headers), App-Control auth (accepts session cookie + same-host Origin; rejects
    token-only and host-mismatch, with missing/malformed Origin and default-port-
    normalization cases — **not** scheme mismatch, which host-only intentionally accepts) +
    **post-upgrade revalidation** (socket closes after session invalidation),
    malformed/oversized/binary App-Control input handled safely, and
    Debug Subscribers excluded from Client Count. **Integration purity test** (Codex #13):
    wire a Downstream Client, a Debug Subscriber, and a fake Relay, then assert diagnostics
    (`proxy_status`, `frame`, `clients`, `webhook`) reach only the App-Control socket while
    genuine Soloist frames arrive byte-for-byte unchanged on `/` and at the Relay. Add a
    response-header **allowlist** test (an `x-api-key`/`set-cookie` response header is omitted)
    and a logout test (an App-Control socket is closed when a matching `POST /logout` fires).
    The XSS-escaping assertion (step 11) targets an **exported highlighting helper** (assert
    its output escapes `<img onerror>` / `</code></pre><script>`), since the zero-dep Node
    `test()` harness can't mount a Vue component. Keep the zero-dep `test()` harness.

## Key decisions & tradeoffs

- **App-Control WS separate from the `/` Soloist data stream** — the stream Downstream
  Clients and the Relay consume stays pure. See **ADR-0016** (Debug Subscriber tier +
  Webhook Delivery History) and **ADR-0017** (`proxy_status` on the App-Control WS, and why
  `overlay_config` stays on `/` while `proxy_status` does not).
- **No self-exclusion** — the client list/count include the viewer's own control
  connection; Debug Subscribers are simply not Downstream Clients, so no `cid`/hello-frame
  machinery is needed (keeps the `/` stream untouched).
- **Webhook auth redaction + bounded capture** — `Authorization` stored as `Bearer ***`;
  bodies size-capped; last 10, in-memory, lost on restart (ADR-0016).
- **highlight.js, lazy-loaded on the Debug route** — maintained highlighter, cost isolated
  to the one page; lean main bundle preserved (**ADR-0018**).
- **Soloist status = process + link + login** — three real states an operator needs.

## Risks / open questions

- **Supervisor state field** (step 3): adds a small state machine to an existing loop; must
  update it at every boundary (waiting/acquiring/starting/running/backoff/expired-reacquiring/
  stopped) under tests, or the Menu shows stale states.
- **Webhook body/header capture** adds latency to the fire-and-forget POST and holds data in
  memory — mitigated by streamed ~8KB cap + reader cancel, 10-entry bound, and response-
  header redaction. Response bodies are third-party content shown to the operator only.
- **Origin check is same-host, by design** — `sameOrigin` compares the `Origin` header's
  host with the request `Host` (normalizing case and default ports); it does not compare
  scheme, because a plain-`createServer` app behind a TLS-terminating proxy has no reliable
  socket scheme, and host-only already defeats CSWSH. Unchanged from today; documented so a
  future reader doesn't "fix" it into breaking reverse-proxied HTTPS.
- **Per-URL webhook stats are removed** — the global last-10 history loses per-destination
  failure counts, and one chatty destination can evict another's entries (Codex #14). This
  is an accepted, user-chosen tradeoff: the Webhooks page no longer shows status, so there is
  no remaining consumer for per-URL counters. Documented, not mitigated.
- **Vite code-split**: verify the dynamic `highlight.js` import (JS + theme CSS) lands in the
  Debug chunk via the emitted manifest, not just a clean compile.
- **Frame mirror uses `hub.observe`** → only decodable JSON frames appear (non-JSON upstream
  frames are dropped, as they are from all observers). Accepted.

## Out of scope

- Moving `overlay_config` off the `/` stream (the overlay holds no Web Session and must
  receive it there).
- Persisting Webhook Delivery History across restarts.
- Frame-type filtering/search on the Debug stream; per-client disconnect/kick actions.
- Retaining per-destination webhook health after the per-URL stats removal.
