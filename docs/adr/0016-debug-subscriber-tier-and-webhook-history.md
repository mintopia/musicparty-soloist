# A session-gated Debug Subscriber tier carries operator diagnostics

The Debug Page needs three live data sets — the Soloist frame stream, the list of
connected Downstream Clients, and a history of recent Webhook deliveries — plus the Menu
needs continuous status on every page. None of that may travel on the Soloist data stream
(the `/` Downstream Client stream), which stays pure by design (ADR-0001): Soloist frames
verbatim, auth enforcement only.

We add a **Debug Subscriber** tier: a session-gated WebSocket (the App-Control
WebSocket, see ADR-0017) distinct from the control/read-only Downstream Client tiers
(ADR-0001, ADR-0008). A Debug Subscriber is authenticated by the Web Session cookie
(ADR-0009) and same-origin only — never by the Auth Token or Read-only Token. It observes
but is *not* a Downstream Client: it never enters the Hub's client set, is never counted
in the Client Count, never appears in the Client list, and can never send a frame upstream
to the Soloist WebSocket. The frame stream it sees is a read-only *mirror* of the Hub's
genuine `onUpstream` ingress — Soloist output only, no client input and no Proxy-originated
frames — so viewing it neither pollutes nor perturbs the Soloist data stream.

To list Downstream Clients with useful detail, the Hub records per-connection metadata at
registration (remote address, tier, auth method, connected-at, user-agent). This is
operator-only data behind the Web Session.

## Webhook Delivery History

Today the Hub keeps per-destination aggregate Webhook Status (counts, last status). We
replace it with a single **Webhook Delivery History**: an in-memory ring buffer of the
last ten deliveries, each capturing event type, URL, HTTP status, round-trip time,
request headers, response headers, and response body. The Menu's Webhook Status is derived
from the newest entry. Consequences, accepted:

- **Secret redaction, both directions.** The outbound `Authorization: Bearer <secret>`
  request header is stored redacted (`Bearer ***`). Response headers are kept by a **fixed
  allowlist** of non-credential names (content-type, content-length, date, server,
  content-encoding, etag, cache-control, age, vary) and every other response header is
  omitted — a third-party endpoint can return arbitrary secret-bearing headers
  (`set-cookie`, `x-api-key`, vendor signatures), so a denylist is not safe; only an
  allowlist is.
- **Bounded capture.** Response bodies are read incrementally up to a byte cap and the
  reader is then cancelled (never buffering the whole body), truncated with a marker. Ten
  entries, global, not per-URL — a deliberate loss of per-destination failure counts, which
  now have no UI consumer.
- **Best-effort, in-memory.** Lost on restart, like the Webhook subsystem itself. No
  persistence, no audit guarantee.

The per-connection client metadata records an `auth` label as a closed enum
(`auth-token` / `readonly-token` / `session-cookie`) derived from the successful auth
branch — never the raw presented token, which must never be stored or shown.

## Considered Options

- **Reuse the `/` Soloist data stream** (tap it client-side for frames; inject
  status/telemetry): rejected — it forces operator telemetry onto the stream Downstream
  Clients and the Relay consume, breaking its purity, and it cannot deliver
  operator-only data (client list, webhook bodies) without leaking to non-operators.
- **Polled JSON endpoints** for clients/webhooks/status: viable and simpler per-call, but
  three polling loops and no live frame stream; a push channel serves the live frame view
  and the Menu badge better with one socket.
- **Dedicated Debug Subscriber tier on a separate session-gated socket** (chosen): one
  operator channel, the Soloist data stream stays pure, and non-operators can never reach
  diagnostics.

## Consequences

The Debug Subscriber tier is a fourth connection class (control, read-only, Relay,
Debug Subscriber). Its auth is the Web Session, so a programmatic Auth Token holder cannot
reach diagnostics — only a logged-in browser. Because the channel exposes client addresses
and third-party response content, its authorization is not left to lapse silently at the
handshake: each Debug Subscriber socket has a bounded lifetime, stores a one-way fingerprint
of its session cookie, and re-checks the session against live config — closing on session
expiry or password rotation, and on `POST /logout` for every socket whose fingerprint
matches the requesting cookie. Diagnostic sends are gated on the socket's `bufferedAmount`
so a slow or backgrounded browser drops frames (and past a threshold is closed) rather than
growing server memory unbounded — the client-side frame ring bounds only the client.

Response bodies and headers on the Debug Page are attacker-controlled (the webhook
destination owns them). Syntax-highlighted output is HTML and so must enter Vue through
`v-html` — the safety boundary is therefore that `v-html` receives **only**
`hljs.highlight(src, …).value` (which HTML-escapes its input), while raw frames, headers,
and bodies enter the DOM **only** through highlight.js or plain text interpolation, never
`v-html` directly and never an auto-language fallback. So a malicious response body cannot
script the authenticated operator page. Because a Debug Subscriber is never a
Downstream Client, the Client Count and Client list describe genuine consumers only; the
operator's own Debug Page connection does not inflate them (though the same browser's
ordinary control connection, via the Soloist data stream, does count and is shown — we do
not special-case it).

The Webhook Delivery History carries response bodies and headers from operator-configured
destinations. That is third-party response content held in memory and shown to the
operator; it is bounded and never persisted, and the only outbound secret (the Webhook
`Authorization`) is redacted before storage.
