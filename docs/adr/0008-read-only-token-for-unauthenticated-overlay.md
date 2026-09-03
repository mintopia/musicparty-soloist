# A read-only token lets the unauthenticated overlay observe playback

The Lyrics Overlay must be unauthenticated (it is loaded by a stream/game scene, not a
person who logs in), yet it needs live playback — current track and position — to sync
lyrics. That data only flows over the Proxy WebSocket, which ADR-0001 gates on the Auth
Token. Handing an unauthenticated page the Auth Token would give any viewer full playback
control.

We add a second Proxy token — the Read-only Token — as a distinct auth tier. A connection
that authenticates with it is registered observe-only: the Hub broadcasts frames to it but
drops any frame it sends upstream. Node embeds this token server-side into the overlay page
it serves, so the overlay connects and observes without a login and without control.

## Considered Options

- **Read-only SSE stream** (a new unauthenticated `GET /api/events` re-emitting state
  frames): rejected — a second egress path and frame format to maintain, when the overlay
  already parses raw WS frames; the WS transport is reused as-is.
- **Embed the Auth Token in the overlay page**: rejected — an unauthenticated page would
  then hold a working control token; anyone opening it could play/pause/skip.
- **A read-only token tier** (chosen): one small change to the WS upgrade auth and the
  Hub's per-client registration; the overlay keeps using the WebSocket unchanged.

## Consequences

The Proxy auth model now has three tiers reaching the WS: the Auth Token and a valid Web
Session grant observe + command; the Read-only Token grants observe only. Because the
Read-only Token is embedded in an unauthenticated page, anyone who can reach the overlay
can read it and observe now-playing — accepted, since it cannot control anything. The
"drop client→upstream frames from read-only connections" rule is the security boundary and
is asserted in `selftest.ts`; a future reader must not "simplify" read-only connections
back into the relay path.
