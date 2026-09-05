# Operator diagnostics ride a separate Debug Subscriber tier, not the Downstream Client flow

The Debug Page needs live operator telemetry — the Soloist frame stream, the connected
Downstream Client list, Webhook Delivery History, and Proxy Status. The `/` Soloist data
stream must stay pure (Soloist frames verbatim + auth only, per ADR-0017), so this
telemetry cannot ride the existing Downstream Client connection.

We add a second WebSocket endpoint, the **App-Control WebSocket** (`/ws/app`), and register
its connections as **Debug Subscribers** in a set entirely separate from the Hub's clients.
A Debug Subscriber is never a Downstream Client: it is never `hub.register`-ed, never
counted in the Client Count, and never forwards a frame upstream. It only observes the
diagnostic streams it subscribes to via `{type:"subscribe",streams:[…]}`, validated against
a fixed set; subscribe is idempotent (a Set dedupes, so no duplicate delivery).

## Considered Options

- **Multiplex telemetry onto `/`** (rejected): pollutes the pure Soloist data stream that
  Downstream Clients, the Relay, and the overlay all consume verbatim, and would leak
  operator-only data to any token holder.
- **A separate App-Control WebSocket** (chosen): keeps `/` pure and lets diagnostics carry
  their own auth, lifecycle, and backpressure policy without touching the client path.

## Auth and lifecycle

The App-Control WebSocket is **operator-only and browser-only**: an upgrade requires a valid
Web Session cookie **and** a same-host `Origin` (`sameOrigin`). Tokens are deliberately not
accepted — this tier is for the logged-in operator's browser, and the same-origin check is
the CSWSH defense for the ambient session cookie. `sameOrigin` stays **host-only** by design
(no scheme compare): a plain `createServer` behind a TLS-terminating proxy sees no reliable
scheme, and host-only already defeats CSWSH; hostname is compared case-insensitively and the
default ports (none/80/443) are treated as equivalent.

Auth is enforced past the handshake, not just at it. Each socket stores a one-way fingerprint
of its session cookie; it has a bounded max lifetime and is re-validated periodically with
`sessionUser`, so it closes on session expiry or password rotation. `POST /logout` closes
every socket whose fingerprint matches the logging-out request before it clears the cookie.

## Backpressure

A slow consumer must never grow Proxy memory unbounded. Every diagnostic send is gated on
`ws.bufferedAmount`: past a drop threshold the high-rate `frame` stream is shed first; past a
hard threshold the socket is closed. The endpoint also runs its own `WebSocketServer` with a
small `maxPayload`, and drops binary or malformed control frames safely.

## Consequences

There is now a fourth credential context: the Web Session also authorizes the App-Control
WebSocket (the Auth Token and Read-only Token do not). Debug Subscribers live in their own
set with their own lifecycle, so Client Count and upstream forwarding are unaffected by the
Debug Page. The stream *producers* (frame fan-out, Proxy Status) are wired separately
(ADR-0017); this tier only owns the endpoint, subscription protocol, auth lifecycle, and
backpressure. The gate, subscribe validation, lifecycle close, backpressure, and logout
close are asserted in `selftest.ts`.
