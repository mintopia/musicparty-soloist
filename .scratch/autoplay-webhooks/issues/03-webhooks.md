# 03: Webhooks

**What to build:** An operator points `webhooks.default_url` at an HTTP listener and
receives a POST for each Soloist state event, body = the raw event JSON. Per-`type`
entries under `webhooks.urls` override the default for that type (each event hits exactly
one URL); the ten state events (`auth_state`, `playback_state`, `track_changed`,
`playback_changed`, `volume_changed`, `device_changed`, `context_changed`,
`options_changed`, `position_sync`, `queue_changed`) use the default when unlisted, while
`command_result`/`error` fire only if given an explicit URL. An optional single `secret`
is sent as `Authorization: Bearer <secret>` on every webhook. `delay_ms` (default 0)
imposes a global minimum interval between POSTs via a FIFO throttle; the queue is bounded
(~1000) and drops oldest with a log line when full. Delivery is best-effort:
fire-and-forget with a ~5s timeout, non-2xx and timeouts logged, never retried. A webhook
must never block relay or the upstream connection. Node built-in `fetch`; no new
dependency.

**Blocked by:** 01 (Hub frame-decode seam + config coercion).

**Status:** done

- [x] `webhooks:` config parsed: `default_url`, `urls` (per-type map), `secret`, `delay_ms` — all optional, `${VAR}`-interpolable, `delay_ms` int-coerced.
- [x] With no webhook config, the Hub sends nothing (relay behavior identical to today).
- [x] Each state event resolves to its override URL if present, else `default_url`, else no POST; `command_result`/`error` only POST with an explicit override.
- [x] POST body is the raw event JSON verbatim, `Content-Type: application/json`, with `Authorization: Bearer <secret>` when `secret` is set.
- [x] `delay_ms` enforces a global min interval (FIFO); a sustained burst past the ~1000 cap drops oldest and logs; non-2xx/timeout logged, no retry; relay/upstream never blocked on a webhook.
- [x] `resolveWebhookUrl(type, cfg)` and the throttle interval are pure and asserted in `selftest.ts` (default vs override vs none; interval spacing; drop-oldest at cap).
- [x] `config.example.yaml` + `README.md` document the `webhooks:` section; CONTEXT.md term already exists.
- [x] `npm test` and `tsc --noEmit` green; no new runtime dependency.
