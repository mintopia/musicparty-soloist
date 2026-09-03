# The Proxy owns the PipeWire fan-out; Audio Outputs are config-driven and UI-selectable

Originally the s6 `snapserver` service linked `soloist-sink:monitor` to Snapserver itself
(ADR-0002/0003), a fixed single-destination route. We now let the operator route Soloist's
audio to any number of Audio Outputs — Snapcast plus local hardware sinks — chosen in the
Landing Page. Because Snapcast becomes just one toggleable output, a background s6 relink
loop would fight the UI turning it off, so **link ownership moves entirely to the Proxy**.

The selected outputs live in the Config File (by PipeWire `node.name`). On boot and on every
output-config save, the Proxy reconciles `soloist-sink:monitor` against that list: it
`pw-link`s each enabled output (Snapcast special-cased to Snapserver's capture node, hardware
sinks generically to `<sink>:playback_{FL,FR}`), waits/retries for a target node to appear
before linking, and `pw-link -d`s deselected ones. It shells out with
`XDG_RUNTIME_DIR=/run/pipewire`, so this is runtime and needs no container or Soloist
restart. Sinks are enumerated for the UI via an authenticated `GET /api/pipewire-sinks`
(`pw-dump`).

## Consequences

- The s6 `snapserver` service no longer runs its own `pw-link` loop (Snapserver still runs);
  the Proxy is the single owner of all fan-out links. The s6 `wait-for-sink` step is
  hardcoded to `soloist-sink` and the user-facing `SOLOIST_PIPEWIRE_DEVICE` env is dropped
  (consistent with ADR-0010 removing env config).
- **Docker-only**, like the rest of the Audio Route. Local hardware sinks exist in the
  container's PipeWire graph only if the operator passes audio devices in (e.g. `/dev/snd`);
  the current compose passes none, so out of the box Snapcast is the only available output.
  Documented as the operator's responsibility.
- Snapcast defaults on. A stored output whose sink is absent at boot is skipped and flagged
  in the UI rather than treated as an error.
