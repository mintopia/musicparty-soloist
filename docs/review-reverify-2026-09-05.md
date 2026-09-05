# Code-review re-verification vs original (2026-09-05)

Re-ran the original 5-agent codebase review (code quality, tests, architecture, UX,
over-engineering) against current `develop` and compared each original finding to the
merged remediation. Branch state: epic/36 merged into `develop` locally (`81fbf74`),
**84 commits ahead of `origin/develop` — not yet pushed**.

## Summary

- **~45 findings genuinely fixed**, verified against the live working tree (not just closed issues).
- **5 partial**, **4 not fixed**, **2 accepted-no-change** (as designed).
- The 3 items the epic marked *"Pending — not yet triaged"* (TEST-L3, ARCH-L5, UX-M2) are all confirmed still undone.
- No silent regressions in tracked findings, but **4 new issues** surfaced — 1 High.
- Backend suite runs green: `npm run test:backend` → 67 passed, 0 failed, 9 skipped.

## Status by axis

| Axis | Fixed | Partial | Not fixed | Accepted |
|---|---|---|---|---|
| Code Quality (QUAL) | 10 | – | QUAL-M4 (deliberate defer) | – |
| Tests (TEST) | 11 | TEST-L2 | TEST-L3 (never issue-tracked) | – |
| Architecture (ARCH) | 7 | #47, #49 | ARCH-L5 | – |
| UX | 15 | UX-H1, UX-L1 | UX-M2 | UX-H4 |
| Over-engineering (YAGNI) | 2 | – | – | YAGNI-2 |

## New issues found by the re-review (ranked)

1. **[High] `src/web-vue/components/MiniPlayer.vue:76-93`** — topbar transport buttons
   (prev/play/next/volume) lack the `:disabled="!connected"` guard that UX-H1 added to
   `Landing.vue`. When the data socket is down they stay clickable and `sendCommand()`
   silently returns. The H1 "dead buttons" defect, left in the always-visible mini-player.
2. **[Med] `src/selftest.ts:2946,2961`** — the unhandledRejection self-test does
   `before = failed` then `failed = before` at the end, erasing any *genuine* detached
   rejection that lands in that window; a real fault can be masked and the process still exit 0.
3. **[Med] `src/hub.ts:26` + `src/wire-contract.ts:36`** — `interface ClientMeta` declared
   twice, byte-for-byte; `hub.ts` doesn't import the contract, so both must be kept in sync
   by hand. Re-seeds the #47 "hand-duplicated contract" smell. `RelayStatus` is likewise
   declared 3 times (`menuStatus.ts:13`, `SettingsRelay.vue:12`, canonical in `wire-contract.ts:20`).
4. **[Med] settings forms** — `<label class="flabel">` sits as a sibling with no `for`/`id`
   on the input, so no programmatic association (clicking the label doesn't focus):
   `TextField.vue:6-9`, `SecretRow.vue:50`, `Webhooks.vue:61,65`, `Audio.vue:96,100`,
   `SettingsSoloist.vue:47`. Login/Setup do this correctly — inconsistent.

Minor (Low): `handleUpgrade` now 8 positional args (proxy.ts:137); backoff constants
`0.5/30` still duplicated in hub.ts/relay.ts; `deferred()` reinvents `Promise.withResolvers()`;
residual bare fixed sleeps in selftest.ts (1461,1697,2543,2560,2865); MiniPlayer volume
`<input type=range>` unlabeled (MiniPlayer.vue:93).

## Not-fixed / partial detail

- **QUAL-M4** — pipewire/runtime module-global mutable state persists; original issue said "not urgent". Deliberate deferral.
- **TEST-L2** — acquire error paths covered, but happy download→extract→chmod and `validateBinary` (acquire.ts:56,88-105) still untested (network-bound).
- **TEST-L3** — `restartSnapserver` (snapserver.ts:55) service bounce never exercised; only the rendered conf + apply-strategy classification are tested. Never had a GitHub issue.
- **ARCH-47** — `wire-contract.ts` single-sources most types, but `ClientMeta`/`RelayStatus` duplication remains (see new issue 3).
- **ARCH-49** — deployment flags *relocated* to `runtime.ts:11,24` as setters, not eliminated; pipewire audio-state singletons untouched.
- **ARCH-L5** — `selftest.ts` is still one file and grew 2079 → **2971 lines**; consolidation merged tests *within* the monolith.
- **UX-H1** — fixed in Landing.vue, missed in MiniPlayer.vue (see new issue 1).
- **UX-L1** — Webhooks/Relay now Title Case, but Soloist/Audio/Web pages still sentence case. Casing still mixes.
- **UX-M2** — reveal failure still swallowed silently (`SecretRow.vue:41-45`). Pending item, never done.

## Accepted-no-change (confirmed still as designed)

- **UX-H4** — seek/volume mouse-only, no keyboard. Confirmed unaddressed (expected).
- **YAGNI-2** — highlight.js for Debug JSON. Now lazy/tree-shaken/XSS-scoped (ADR-0016/0018); the "defensible" call holds, arguably stronger than at original review.

---
_Re-review run 2026-09-05 by 5 parallel axis agents against `develop` @ `81fbf74`._
