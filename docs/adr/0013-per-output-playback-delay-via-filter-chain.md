# Hardware Audio Outputs get a configurable playback delay via a supervised filter-chain

Operators syncing a local DAC to video or a Snapcast client sometimes need to push one
hardware output later by a fixed amount. Amending ADR-0011: each hardware Audio Output
(never the synthetic Snapcast output) now carries an optional `outputDelays[node.name]`
in milliseconds (`audio.output_delays` in the Config File; 0/absent = none, clamped to
0-5000ms), editable in the Landing Page next to its sink row.

The delay is implemented as a PipeWire `libpipewire-module-filter-chain` "delay" node
spliced into that output's fan-out. Where ADR-0011 links `soloist-sink:monitor` straight
to `<sink>:playback_{FL,FR}`, a delayed output instead routes through the filter:
`soloist-sink:monitor_{FL,FR} -> input.soloist-delay-<token>:input_{FL,FR}` (the filter's
capture side) and `output.soloist-delay-<token>:output_{FL,FR} -> <sink>:playback_{FL,FR}`
(its playback side), `<token>` being the sink's `node.name` sanitized to a safe filter
name (collision-suffixed `-2`, `-3`, ... on the rare clash). An undelayed output keeps
the exact ADR-0011 direct link.

**One** filter-chain child process hosts every delayed output's delay node, not one
process per output. `reconcileOutputs` computes the desired `{node.name: ms}` map on
every boot/save reconcile (same trigger and single-slot serialization as ADR-0011); if it
differs from the map the running child was spawned for, the Proxy kills that child (by
the `child_process` handle it kept — the minimal image has no `pkill`) and spawns a fresh
one against a freshly generated conf covering all currently-delayed outputs, or leaves no
child running if the map is empty. The generated conf is self-contained — it loads
`libpipewire-module-protocol-native` and `libpipewire-module-client-node` itself (as the
shipped `filter-chain.conf` wrapper does) so `pipewire -c <conf>` can register as a client
against the running daemon — rather than reusing that wrapper's drop-in directory.

## Considered Options

- **One filter-chain process per delayed output**: rejected — needless process sprawl for
  what's a handful of delay nodes; one process hosting an array of filter-chain module
  blocks does the same job.
- **Drop-in file into the shipped `filter-chain.conf` wrapper's conf dir**: rejected in
  favour of a self-contained generated conf — equivalent capability, one fewer moving
  part to keep in sync with the wrapper's directory conventions.
- **Live, glitch-free delay changes** (e.g. ramping the filter's control value instead of
  respawning): rejected as gold-plating for a calibration knob the operator sets once and
  rarely touches; a brief glitch on Save is an accepted trade-off, not a regression.

## Consequences

- Delay changes apply on config Save, like every other Audio Output change (ADR-0011) —
  not live. Because changing the map kills and respawns the shared child, **every**
  currently-delayed output glitches briefly at that moment, not just the one whose delay
  changed. Documented as expected for a calibration control, not a bug.
- Docker-only, and a no-op wherever ADR-0011's reconcile already no-ops (no reachable
  PipeWire graph, e.g. standalone) — the delay child is never spawned in that case either.
- A configured delay on an output whose sink node never appears is flagged missing the
  same way ADR-0011 already flags an absent undelayed output; the delay filter itself is
  not spawned speculatively for outputs that end up missing.
