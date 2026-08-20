# 02: Autoplay

**What to build:** An operator can set `autoplay: true` (default off) and, once the
device is paired, the Hub makes it the active Connect player and starts playing on its
own. Concretely: on each upstream connection, the first time an `auth_state` reports
`logged_in: true`, the Hub injects `activate` then `play` upstream, back-to-back, no ack
wait — once per connection, with no re-fire on later `auth_state` frames in that same
connection. A restart of an already-paired Soloist re-asserts on reconnect. `activate`/
`play` require login, so the login gate is the trigger, not mere connection. Any
resulting `error` frame is logged; no retry. Injected frames are not client-originated —
they go straight upstream.

**Blocked by:** 01 (Hub frame-decode seam + config coercion).

**Status:** done

- [x] `autoplay` config value (top-level, bool, default false, `${VAR}`-interpolable).
- [x] With `autoplay` off, the Hub never injects anything (relay behavior identical to today).
- [x] With `autoplay` on, first `logged_in:true` per upstream connection injects `activate` then `play` (in that order); no further injection on subsequent `auth_state` frames in the same connection.
- [x] Reconnecting to an already-paired Soloist re-fires the sequence on the new connection.
- [x] Trigger is a pure `shouldAutoplay(prev, next)` decision, asserted in `selftest.ts` (covers not-logged-in, false→true, already-true-on-connect, and the once-per-connection guard).
- [x] `config.example.yaml` + `README.md` document `autoplay`; CONTEXT.md term already exists.
- [x] `npm test` and `tsc --noEmit` green.
