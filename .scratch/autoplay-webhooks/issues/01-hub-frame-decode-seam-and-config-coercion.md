# 01: Prefactor — Hub frame-decode seam + config coercion

**What to build:** The enabling infra both features sit on, with no user-visible
behavior change. `SoloistHub` decodes each upstream frame's JSON `type` **once** on the
broadcast path and dispatches to registered observers (a small seam Autoplay and
Webhooks each hook into), instead of every feature re-parsing frames. Non-JSON / binary
frames pass through the observer path untouched. The client↔hub relay and the broadcast
to Downstream Clients stay byte-for-byte identical (ADR-0001 / ADR-0006). Separately,
`loadConfig` gains bool and int coercion helpers so later tickets can add typed config
values (env and `${VAR}` interpolation only ever yield strings).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Hub parses each upstream frame's `type` once and dispatches to any registered observers; broadcast to clients is unchanged (byte-exact, binary frames still relayed).
- [ ] A malformed/non-JSON upstream frame does not throw or break relay; it is skipped by observers and still broadcast.
- [ ] `loadConfig` exposes bool coercion (`true/false/1/0/yes/no`, default-aware) and int coercion (default-aware), used by no config keys yet.
- [ ] `selftest.ts` asserts the coercion helpers and the decode/dispatch (including the malformed-frame skip).
- [ ] `npm test` and `tsc --noEmit` green; no new runtime dependency.
