# Config apply-strategy is a declarative table, not scattered mechanism

Config (ADR-0010) is edited live through `PUT /api/config`. How a saved field actually
takes effect was spread across four modules and three mechanisms (finding ARCH-M4):

- **live** — auth tokens, web session, webhooks and autoplay are read straight off the
  shared `Config` object, so a save applies the moment the object is mutated in place.
- **callback** — overlay styling, the Relay connection and the PipeWire fan-out need a
  post-save action (`onConfigChange` / `reconcileOutputs`) to push or re-dial.
- **restart** — Soloist spawn args (`buildArgv`) and the snapserver template
  (`renderSnapserverConf`) only apply on a restart, surfaced by the two "restart to
  apply" banners.

Nothing named which mechanism a given field used, so adding a field could silently
require a restart or do nothing, and the live-apply path depended on an unwritten rule:
the one `Config` object must be **mutated, never reassigned**, or live consumers keep
reading a stale object.

## Decision

`src/config.ts` now carries **`APPLY_STRATEGY`**, a table mapping every config field to
one of `live | callback | restart-soloist | restart-snapcast | restart-process`. Its
`satisfies Record<keyof …>` lines make TypeScript reject any config section that adds a
field without classifying it. The mutate-never-reassign contract is documented on the
`Config` type.

The runtime detectors are unchanged — `buildArgv` (Soloist) and `renderSnapserverConf`
(snapserver) remain the source of the pending-restart banners because they compare the
*effective* output, not raw field values. Instead a selftest pins the table to them: every
`restart-soloist` field must change `buildArgv` and nothing else, every `restart-snapcast`
field must change the rendered conf and nothing else, and `live`/`callback`/`restart-process`
fields must change neither. A misclassified or unclassified field fails the build or the test.

## Consequences

- Adding a config field forces a strategy choice at compile time; "silently doesn't apply"
  is no longer possible without a failing build or test.
- The table is documentation and an enforced contract, not a dispatch engine: it does not
  replace the live/callback/restart wiring, it governs and verifies it.
- `restart-process` (currently only `proxy.listen`) documents locked structural fields that
  need a full container restart and have no banner because PUT can never change them.
