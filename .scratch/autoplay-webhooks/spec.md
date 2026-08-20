# Autoplay + Webhooks

Two Hub features. Both make `SoloistHub` (`src/proxy.ts`) inspect/inject upstream
frames — amending ADR-0001's "dumb pipe" (see ADR-0006). The client↔hub relay stays
byte-for-byte unchanged; only the upstream-observation and upstream-injection paths are
new. Every Soloist WS frame is JSON with a `type` field.

## Autoplay

Opt-in Hub behavior (`autoplay`, default off). On each upstream connection, the first
time an `auth_state` reports `logged_in: true`, the Hub injects `activate` then `play`
back-to-back (no ack wait) so the device becomes the active Connect player and starts
playing. Once per upstream connection; a restart of an already-paired Soloist re-asserts
on reconnect; no re-fire on later `auth_state` frames. `activate`/`play` require login,
so the login gate is load-bearing. Failures come back as `error` frames — logged, not
retried.

## Webhooks

Outbound HTTP POST per Soloist event. Config `webhooks:`:

- `default_url` — catch-all for the ten state events (`auth_state`, `playback_state`,
  `track_changed`, `playback_changed`, `volume_changed`, `device_changed`,
  `context_changed`, `options_changed`, `position_sync`, `queue_changed`).
- `urls` — per-`type` overrides that **replace** the default for that type (so an event
  hits exactly one URL). `command_result`/`error` fire only if explicitly given a URL.
- `secret` — optional; sent as `Authorization: Bearer <secret>` on every webhook.
- `delay_ms` — global min interval between POSTs (default 0 = off).

POST body is the raw event JSON verbatim, `Content-Type: application/json`. Best-effort:
fire-and-forget, ~5s timeout, log non-2xx/timeout, no retry. Throttle is a global FIFO
with a bounded (~1000) drop-oldest queue that logs drops. Node built-in `fetch`; no new
dependency.

## Config typing

New keys are `${VAR}`-interpolable and optional. `loadConfig` gains bool + int coercion
(env/interpolation yield strings). `autoplay` is top-level; webhooks under `webhooks:`.

## Self-checks

Three branchy decisions factored as pure functions and asserted in `selftest.ts`:
`shouldAutoplay(prev, next)`, `resolveWebhookUrl(type, cfg)`, and the throttle interval.

## Decisions deliberately NOT built

Autoplay ack-wait/retry; webhook HMAC signing; per-type debounce; delivery guarantees /
durable queue.

## References

- Soloist WS protocol: https://developer.spotify.com/documentation/soloist/reference/websocket-api
- ADR-0006 (this change), amends ADR-0001. CONTEXT.md terms: Autoplay, Webhook.
