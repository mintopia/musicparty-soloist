# Proxy Status telemetry rides the App-Control WebSocket, not the Soloist data stream

The Landing Page Menu shows live status on every page — Soloist process/link/login,
Client Count, Relay connection, Webhook Status — and a worst-of-state badge dot on its
trigger. That status must be pushed (no polling) and must be current even when the Menu is
closed.

The Soloist data stream (the `/` Downstream Client stream) must stay pure: it carries
Soloist frames verbatim, with the Proxy adding nothing but auth (ADR-0001). Downstream
Clients and the Relay (ADR-0012) consume it as the canonical Soloist feed. Injecting
Proxy-originated telemetry into it would corrupt that feed for every consumer.

So the **Proxy Status** frame is pushed only over the **App-Control WebSocket** (ADR-0016)
— the operator's session-gated channel — never over the Soloist data stream. The Landing
Page opens the App-Control WebSocket app-wide (in addition to its Soloist data connection)
and reads Proxy Status from it. The badge and status entries derive from the newest Proxy
Status plus the browser's own view of whether its Soloist data connection is live.

## Why `overlay_config` stays on the Soloist data stream but Proxy Status does not

The Proxy already broadcasts one Proxy-originated message, `overlay_config`, on the
Soloist data stream when the Overlay Config changes. That is deliberate and stays: the
Lyrics Overlay holds only the Read-only Token (ADR-0008), has no Web Session, and *cannot*
open the App-Control WebSocket — yet it must restyle live, so it needs that message on the
one stream it can reach. Proxy Status is the opposite case: it is operator-only telemetry
for the Menu, its audience holds a Web Session, and it has no business reaching Downstream
Clients or the Relay. Audience decides the channel: overlay styling → the shared stream
its recipient can reach; operator telemetry → the operator channel.

## Considered Options

- **Broadcast Proxy Status on the Soloist data stream** (like `overlay_config`): rejected
  — it pushes operator telemetry to every Downstream Client and republishes it to the
  Relay Server, polluting the pure Soloist feed for consumers that neither want nor should
  see it.
- **Poll a `/api/status` endpoint** from the Menu: viable, but polling on every page for a
  badge that should reflect problems promptly; the App-Control WebSocket already exists for
  the Debug Page, so Proxy Status reuses it for free.
- **Push over the App-Control WebSocket** (chosen): one operator channel, zero pollution of
  the Soloist data stream, live badge without polling.

## Consequences

The Relay never receives Proxy Status: it republishes only genuine `onUpstream` frames
(ADR-0006/0012), and Proxy Status is neither injected upstream nor placed on the Soloist
data stream. Downstream Clients likewise never see it. If the App-Control WebSocket is
down, the Menu has no fresh telemetry; the browser detects this from its own connection
state and the badge reflects "disconnected" rather than showing stale-but-green status.
