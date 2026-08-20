# A thin auth proxy fronts Soloist's WebSocket

Soloist's control WebSocket (`-w`) is unauthenticated by design and meant to bind
to localhost only. To expose control to remote clients we run our own Python
WebSocket server — the Proxy — that gates connections on a single shared Auth Token
(`Bearer` header or `?token=`, 401 on failure) and then transparently relays frames
to Soloist's localhost WS.

## Considered Options

- **Expose Soloist's WS directly** (bind `0.0.0.0`): rejected — no auth, no TLS, no
  origin checks; anyone on the network gets full playback control.
- **Add auth by patching Soloist**: impossible — closed binary, redistribution
  prohibited.

## Consequences

The Proxy does no message rewriting; it is deliberately a dumb pipe. A future reader
seeing a proxy that "does nothing" should know its sole job is authentication —
that is why it exists.
