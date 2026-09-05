# Plan Review Log: Menu + Debug Page + live status

Act 1 (grill-with-docs) complete — plan locked, CONTEXT.md + ADR-0016/0017/0018 written. MAX_ROUNDS=5.
Codex: codex-cli 0.145.0, model = CLI default (no pin in ~/.codex/config.toml).

## Round 1 — Codex

VERDICT: REVISE. 16 findings (verbatim summary):
1. **Critical** — client `auth` metadata derived from `presentedToken()` could store/expose the literal Auth/Read-only Token.
2. **High** — `proxy_status` carrying full latest webhook delivery (headers+body) every 3s to every page; contradicts ADR-0017, wastes bandwidth, pre-subscription exposure.
3. **High** — `res.text().slice()` buffers the whole body; no real memory bound.
4. **High** — response headers captured without redaction (Set-Cookie, WWW-Authenticate, etc.).
5. **High** — `sameOrigin()` is same-host only (ignores scheme); no reverse-proxy policy.
6. **High** — App-Control auth evaluated only at handshake; socket stays privileged after logout/expiry/pw-rotation.
7. **High** — no backpressure for Debug Subscribers; slow browser grows server send-queue.
8. **Medium** — `onEntry(cb)` has no unsubscribe contract → callback leak across mounts/reconnects.
9. **Medium** — App-Control input has no size/shape/state limits (maxPayload, binary, malformed, duplicate subscribe).
10. **Medium** — planned Soloist process states don't match the transient supervisor lifecycle (waiting/acquire/backoff/reacquire).
11. **Medium** — `loggedIn()` reads cached `latestState` that survives disconnect → `upstream:false, loggedIn:true`.
12. **Medium** — shutdown cleanup missing: status interval, Debug sockets, observer subs not in `RunningProxy.close()`.
13. **Medium** — purity asserted but not tested at the routing boundary (accidental `hub.broadcastMessage`).
14. **Medium** — global last-10 discards per-URL failure counts; one chatty destination evicts others.
15. **Low** — App-Control disconnect absent from badge rules; stale telemetry could stay green (ADR-0017).
16. **Low** — lazy-loading not specified vs the static router; theme CSS could leak into main bundle.

### Claude's response

Accepted 15 of 16 and revised PLAN.md + ADR-0016 accordingly:
- #1 → `auth` is now a closed enum from the successful `checkAuth` branch; raw token never stored (verified `presentedToken` returns the literal token).
- #2 → `proxy_status` webhook field reduced to compact `{at,status,ok,type}`; full detail only on the subscribed `webhook` stream.
- #3 → stream-read `res.body` to the byte cap + cancel reader; never `res.text()`.
- #4 → redact response headers by credential-bearing name / allowlist, both directions.
- #5 → harden `sameOrigin` to scheme+host (verified it compares `URL(origin).host===host`); documented reverse-proxy caveat; noted it also tightens the existing cookie-upgrade path.
- #6 → App-Control sockets get bounded lifetime + periodic `sessionUser` revalidation; `POST /logout` closes the socket.
- #7 → gate diagnostic sends on `ws.bufferedAmount`; drop frames / close past threshold.
- #8 → `onEntry`/`subscribe` return idempotent disposers; disposed on unsubscribe/close/error/shutdown.
- #9 → own `WebSocketServer` with small `maxPayload`; reject binary/malformed; validate `streams` against a fixed set; idempotent subscribe.
- #10 → supervisor gains a `state` field updated at each loop boundary; exposed enum waiting/acquiring/starting/running/backoff/expired-reacquiring/stopped.
- #11 → `loggedIn()` returns `boolean|null`, `null` when `!upstreamConnected`; `latestState` NOT cleared (its replay role is preserved) — the null is derived.
- #12 → `RunningProxy.close()` clears the interval, disposes observers, terminates Debug sockets, awaits App-Control WSS close.
- #13 → added an integration purity test (Downstream Client + Debug Subscriber + fake Relay) asserting diagnostics stay off `/` and the Relay and Soloist frames pass byte-for-byte.
- #15 → badge exposes App-Control connection state; disconnected/unknown outranks green; stale status aged out.
- #16 → `/debug` route is a lazy component import; hljs + theme CSS kept in the async chunk; verify via emitted manifest.
- #14 → **partially rejected the mitigation, accepted the observation.** The per-URL loss is a deliberate, user-chosen tradeoff (the Webhooks page no longer shows delivery status, so no consumer remains for per-URL counters). Documented in PLAN risks + ADR-0016; not adding per-URL counters.

## Round 2 — Codex

VERDICT: REVISE. 13/16 fully addressed, #14 accepted. Partial: #4, #5, #6. New: #17.
- #4 partial — denylist can't cover arbitrary secret headers (x-api-key, vendor sigs). Fix: fixed allowlist.
- #5 partial — "scheme-aware + reverse-proxy caveat" isn't an implementable rule on plain createServer (TLS terminates at proxy). Fix: pick one exact policy.
- #6 partial — "/logout closes that browser's socket" needs a defined request↔socket association. Fix: cookie fingerprint on each socket; /logout closes matches.
- #17 **High (new)** — highlighting attacker-controlled webhook response bodies via v-html is an XSS vector on the authed operator page. Fix: escape-safe rendering only; test `<img onerror>` / `</code></pre><script>`.

### Claude's response

All four resolved with exact policies:
- #4 → fixed response-header allowlist (content-type, content-length, date, server, content-encoding, etag, cache-control, age, vary); every other response header omitted.
- #5 → **keep host-only `sameOrigin`, deliberately** — scheme derivation is unimplementable behind a TLS-terminating reverse proxy (plain createServer has no real scheme), and host-only already defeats CSWSH (a cross-site attacker's Origin host never matches) with the HttpOnly SameSite=Lax cookie as second gate. Dropped the earlier "scheme-aware" idea as wrong for this deployment.
- #6 → each App-Control socket stores a one-way fingerprint of its session cookie; `POST /logout` closes every socket whose fingerprint matches before clearing the cookie; periodic revalidation + bounded lifetime as backstop.
- #17 → XSS contract added to PLAN step 11 + ADR-0016: render only via `hljs.highlight().value` (HTML-escaping) or textContent/interpolation, never `v-html`, no `highlightAuto` fallback; component test with `<img src=x onerror=…>` and `</code></pre><script>…` payloads.

## Round 3 — Codex

VERDICT: REVISE. #4/#5/#6/#17 substantively resolved; Codex explicitly agrees with host-only Origin matching. Three stale/wording inconsistencies:
1. Tests still require scheme-mismatch rejection, contradicting host-only. Fix: host mismatch / missing / malformed Origin / default-port normalization instead.
2. Risks section still says "scheme derivation / sameOrigin hardening", contradicting step 7. Fix: describe Origin.host vs Host with normalization.
3. ADR-0016 "never via v-html" is wrong — highlighted HTML must enter via v-html; the boundary is that only hljs-escaped output does, raw text never.

### Claude's response

All three are consistency fixes; applied:
- (1) test list now: same-host Origin accepted; token-only + host-mismatch rejected; missing/malformed Origin + default-port normalization; explicitly NOT scheme-mismatch.
- (2) risk rewritten: same-host by design (Origin.host vs Host, case + default-port normalized, no scheme compare, CSWSH-sufficient, don't "fix" into breaking reverse-proxied HTTPS).
- (3) ADR-0016 reworded: v-html receives only `hljs.highlight().value`; raw frames/headers/bodies enter only via highlight.js or text interpolation, never v-html directly, no auto-language fallback.

## Round 4 — Codex

VERDICT: APPROVED. All three consistency fixes present and coherent; no new security, lifecycle, stream-purity, or schema findings. One non-blocking implementation note: the Debug.vue XSS check can't run in the Node-only selftest harness — test an exported highlighting helper's escaped output instead (folded into PLAN step 14).

## Resolution — converged (APPROVED, round 4)

Act 2 stopped early on user request (they asked for grill-with-docs, not the -codex variant). Plan is APPROVED as of round 4; no code written.
