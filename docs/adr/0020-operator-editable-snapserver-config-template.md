# Snapserver.conf is an operator-editable template with placeholders

Previously the s6 `snapserver` run script hardcoded the whole `snapserver.conf`, deriving
only the `[stream]` source name from `snapcast.stream_name` (ADR-0002/0010). Operators who
wanted to change Snapserver settings — codec, buffer, ports, disabling the web UI — had no
way to do so short of editing the image.

The Config File now carries the **entire snapserver.conf as an operator-editable template**
(`snapcast.server_config`) plus a `snapcast.snapweb` toggle. The template supports two
placeholders, substituted at render time by `src/snapserver.ts`:

- `{{stream}}` → the pipewire capture source line, still derived from `streamName` so the
  Audio Route (ADR-0011) keeps working unchanged.
- `{{snapweb}}` → `true`/`false`, wired to the `snapweb` toggle; the default template uses it
  as `enabled = {{snapweb}}` in `[http]`, so turning Snapweb off stops serving the web UI.

The **same renderer** feeds both the s6 run script (at container start) and the Proxy's
apply-on-demand path, so the file on disk is byte-identical to what the Proxy would produce.
That equality is the signal for the "restart Snapcast to apply" banner: the Proxy compares
its render against `/etc/snapserver.conf` and, on request, rewrites the file and bounces just
the snapserver s6 longrun (`s6-svc -r /run/service/snapserver`) via `POST /api/restart-snapcast`.

## Consequences

- **Docker-only** (like the rest of the Audio Route). Standalone has no Snapserver; the
  Settings section and the pending-restart check are gated on `isDockerMode()`.
- Changes are **not** live: Snapserver only re-reads its conf on restart, so the UI mirrors
  the existing Soloist pattern — save persists, a banner offers the restart. Restarting
  snapserver briefly drops LAN Snapcast audio; Soloist, the Proxy, and PipeWire are untouched.
- The template is operator-authored and applied verbatim (minus placeholder substitution).
  It is only reachable behind the session-authed config API, so an invalid conf is an
  operator footgun, not a security boundary; an empty template falls back to the built-in
  default so Snapserver can never be handed a blank file. The s6 run script also falls back
  to a safe default if rendering throws before `/config` is seeded.
- The top-bar Snapweb link is hidden when `snapweb` is off (the server wouldn't answer).
