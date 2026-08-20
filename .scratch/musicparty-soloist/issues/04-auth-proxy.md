# 04: Auth proxy

**What to build:** The Proxy — a WebSocket server on the configured listen address (`0.0.0.0:8687`) that authenticates each connection and then transparently relays frames to Soloist's local WebSocket. A Downstream Client presenting the Auth Token gets live playback state and can send control commands; a bad or missing token is rejected at the upgrade. Completes the standalone deliverable (no audio). See ADR-0001 for why this proxy exists.

**Blocked by:** 01, 03.

**Status:** ready-for-agent

- [ ] Token accepted via `Authorization: Bearer <token>` header or `?token=<token>` query param
- [ ] Missing/incorrect token → 401 at the WS upgrade; comparison is constant-time
- [ ] Authenticated connections relay frames both ways verbatim (no rewriting)
- [ ] Multiple clients served concurrently (fan-out) against the single Soloist WS
- [ ] Self-test (assert-based) covers the auth gate: good token passes, bad/missing → 401
