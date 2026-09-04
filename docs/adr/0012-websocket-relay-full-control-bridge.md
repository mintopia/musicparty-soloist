# The WebSocket Relay is a full-control bridge trusted by operator configuration

The Relay is a new Hub observer (ADR-0006 lineage): a single persistent *outbound*
WebSocket the Proxy opens to an operator-configured Relay Server. It republishes every
genuine Soloist→downstream frame to that server verbatim, and relays every frame it
receives back **into the upstream Soloist socket** as raw bytes. That inbound direction
is the load-bearing decision: the Relay Server can play, pause, skip, set volume — full
control of playback — over a channel the Proxy never authenticates per-frame.

We accept this because trust is established once, by the operator, when they configure
the Relay: they chose the destination URL, and they may attach a single verbatim
`Authorization` header the Proxy sends on the outbound upgrade. There is no per-frame
authorization on the relayed traffic, by design — the Relay Server is treated like a
Downstream Client holding the Auth Token (full control), not the Read-only Token.

## Considered Options

- **Observe-only relay** (mirror out, drop everything in): rejected — the feature's
  purpose is a bidirectional bridge; a remote controller that cannot control is a
  Webhook with extra steps.
- **Parse and validate inbound frames before injecting** (JSON-object gate via
  `hub.inject`): rejected — Soloist's control WS already ignores malformed input, and
  the operator explicitly wanted a transparent passthrough. Inbound frames go straight
  to the upstream socket as raw bytes (`hub.sendUpstream`), never decoded.
- **Full-control raw passthrough** (chosen): symmetric verbatim bytes both ways. Trust
  is the operator's configuration act.

## Consequences

Loop-safe by construction: the Hub only fans a frame out to observers on genuine
Soloist→downstream ingress (`onUpstream`); an injected/forwarded frame is written
straight to the upstream socket and never re-enters that path (ADR-0006). So a frame the
Relay Server sends in cannot echo back out to the Relay Server.

The Relay is best-effort like the Webhook: while the Relay Server is disconnected,
outbound frames are dropped (no buffer, no backlog flush of stale now-playing state);
it reconnects with backoff (0.5s→30s) forever while a url is configured, and re-dials
live when the operator changes the url or Authorization. There is no application-level
keepalive ping — the ~10s Soloist frame cadence while playing surfaces a broken outbound
socket; a socket that dies during a long pause is noticed on the next frame.

Security note for a future reader: anyone who can make the Proxy's configured Relay
Server accept its outbound connection can drive playback. The mitigations are the
operator's alone — a trusted URL and, where the server supports it, the Authorization
header. The `authorization` value is a Config File secret (masked in the Landing Page,
never rendered).
