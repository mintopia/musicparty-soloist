# The Hub inspects frames for webhooks and injects for autoplay

ADR-0001 made the Proxy a dumb pipe: gate on the Auth Token, then relay frames both
ways with no rewriting. Two new features need the `SoloistHub` — which owns the single
upstream connection — to stop being blind to payloads:

- **Webhooks**: on each *upstream* message the Hub parses the JSON `type` and, for the
  ten state events, POSTs the raw event to an operator-configured URL (a `default_url`
  catch-all plus per-`type` overrides). Best-effort, fire-and-forget, global
  min-interval throttle over a bounded queue.
- **Autoplay**: once the upstream is connected and an `auth_state` reports
  `logged_in: true`, the Hub *injects* `activate` then `play` upstream (once per
  connection) so the device becomes the active Connect player and starts playing.

Both live in the Hub because it already owns the one upstream connection and its
reconnect lifecycle. The three branchy decisions — the login-edge autoplay gate, the
default-vs-override webhook routing, and the throttle interval — are factored as pure
functions and asserted in `selftest.ts`.

## Considered Options

- **A separate consumer that opens its own authed WS to the Proxy** (like any other
  Downstream Client) and parses/injects from outside the core: rejected — a second
  upstream consumer with its own reconnect logic and auth handling, duplicating what
  the Hub already does, to preserve a purity that was never the point.
- **Extend the Hub** (chosen): the observation tap and the injection path attach to the
  connection the Hub already manages. The client↔hub relay stays byte-for-byte
  unchanged.

## Consequences

This amends ADR-0001. The invariant that still holds is the one that mattered: the Hub
never rewrites *Downstream Client* traffic — client frames reach Soloist unchanged and
Soloist frames reach clients unchanged. What is new is that the Hub now (a) *reads*
upstream frames to fire webhooks and track `auth_state`, and (b) *originates* its own
`activate`/`play` frames upstream that no client sent. A future reader seeing ADR-0001's
"dumb pipe" should read it as "no rewriting of relayed traffic", not "never looks at or
originates frames". Webhooks are best-effort by design: a slow receiver is throttled and
an overflowing queue drops oldest — the Hub must never block relay or the upstream on a
webhook.
