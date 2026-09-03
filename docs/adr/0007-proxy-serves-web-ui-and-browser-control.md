# The Proxy serves a web UI and browser control on its own port

ADR-0001 made the Proxy a WebSocket server whose only surface was the WS upgrade
(gate on the Auth Token, relay frames). We now need an operator-facing web app —
the Landing Page — that shows the Soloist WebSocket details and current config, links
to Snapweb, lists Webhooks with their Webhook Status, gives playback status and basic
controls, and edits the Overlay Config; plus an unauthenticated Lyrics Overlay page.

The Proxy already owns a Node `http.Server` (the WS rides its `upgrade` event) and a
`SoloistHub` that decodes every state frame and can inject commands upstream. Rather than
stand up a second service that would re-open its own authed WS to the Hub, duplicate the
config load, and add a process to supervise, we add HTTP request routing to the same
server on the same listen port. The browser drives playback over the existing WS (with a
Web Session cookie), not a parallel REST control layer — one frame protocol, reused.

## Considered Options

- **A separate web service** (new s6 entry) talking to the Hub as another Downstream
  Client: rejected — two processes, duplicated auth/config wiring, and the control path
  one hop removed from the Hub that already has the state and the injection primitive.
- **Caddy serves static pages + a thin Node API**, ACME/TLS in Caddy: rejected — splits
  the app across a Caddyfile and Node, and pulls TLS/reverse-proxy into this project's
  scope. TLS and any public reverse proxy are left to the operator to place in front.
- **Extend the Proxy's `http.Server`** (chosen): HTTP routes and the WS live in one
  process on one port; the control API *is* the WS.

## Consequences

This amends ADR-0001 and ADR-0006. The Proxy is no longer WS-only: its port now serves
the Landing Page, the config/overlay JSON API, and the two browser-served HTML pages, in
addition to the WS upgrade. The relay invariant is unchanged — Downstream Client frames
are still never rewritten. A future reader seeing "auth proxy" should know it also serves
the web UI. There is now no TLS in this project by design; the operator adds a reverse
proxy in front if they want HTTPS or a hostname.
