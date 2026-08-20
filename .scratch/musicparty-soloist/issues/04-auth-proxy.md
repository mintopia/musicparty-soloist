# 04: Auth proxy

**What to build:** The Proxy — a WebSocket server on the configured listen address (`0.0.0.0:8687`) that authenticates each connection and then transparently relays frames to Soloist's local WebSocket. A Downstream Client presenting the Auth Token gets live playback state and can send control commands; a bad or missing token is rejected at the upgrade. Completes the standalone deliverable (no audio). See ADR-0001 for why this proxy exists.

**Blocked by:** 01, 03.

**Status:** done

- [x] Token accepted via `Authorization: Bearer <token>` header or `?token=<token>` query param
- [x] Missing/incorrect token → 401 at the WS upgrade; comparison is constant-time
- [x] Authenticated connections relay frames both ways verbatim (no rewriting)
- [x] Multiple clients served concurrently (fan-out) against the single Soloist WS
- [x] Self-test (assert-based) covers the auth gate: good token passes, bad/missing → 401

## Comments

Implemented in `soloist_proxy/proxy.py`. Auth at the WS upgrade via `process_request`:
`_presented_token` reads the `Bearer` header or `?token=` query, `hmac.compare_digest`
(constant-time) compares against `proxy.token`, bad/missing → 401. `SoloistHub` holds a
*single* shared upstream WS to Soloist and fans out — every upstream frame broadcast to
all Downstream Clients, every client frame forwarded onto that one upstream (spec:
"N clients ↔ 1 Soloist WS"). Frames relayed verbatim (str/bytes). Hub reconnects with
capped backoff. `soloist_proxy/__main__.py` runs supervisor + proxy together as the
standalone deliverable. Self-test `test_proxy.py` covers good/bad/missing token → 401,
verbatim binary relay, and two-client fan-out over one upstream. Added `websockets>=13`
to requirements.
