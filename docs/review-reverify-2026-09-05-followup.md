# Review re-verification — follow-up after #74–#77 (2026-09-05)

Gated on the four findings from the 2026-09-05 re-review. Issues #74, #75, #76 and
#77 are all CLOSED and merged into `develop`. This pass re-runs the affected review
axes against `develop` and re-checks the three still-open carry-overs the original
re-review flagged.

Verdict key: **FIXED** / **PARTIAL** / **NOT-FIXED** (for landed fixes);
**STILL-OPEN** (for carry-overs, which were not expected to be fixed here).

## Summary

| Item | Axis | Verdict |
| --- | --- | --- |
| #74 — MiniPlayer transport guard | UX | **FIXED** |
| #77 — settings label/input association | UX | **PARTIAL** |
| #75 — unhandledRejection self-test | Tests | **FIXED** |
| #76 — wire-contract dedup | Architecture | **FIXED** |
| ARCH-L5 — selftest monolith | Architecture | **STILL-OPEN** |
| UX-M2 — silent secret-reveal failure | UX | **STILL-OPEN** |
| TEST-L3 — snapserver restart untested | Tests | **STILL-OPEN** |

One new issue found: per-event webhook override row inputs are unlabelled (a
carry-over gap of #77). See **New issues** below.

---

## UX

### #74 — MiniPlayer transport guard — FIXED

Every transport surface in the always-visible mini-player is now gated on the data
socket, mirroring the Landing.vue UX-H1 treatment.

- `src/web-vue/components/MiniPlayer.vue:14` — `const connected = computed(() => state.connected);`
- `:disabled="!connected"` on prev (`:77`), play/pause (`:80`), next (`:84`), volume
  toggle button (`:88`), and the volume `<input type="range">` (`:94`).
- Disconnected cue: `src/web-vue/components/MiniPlayer.vue:99-107` —
  `role="status" aria-live="polite"` "Disconnected — reconnecting…" strip mirroring
  Landing's `.disc`.
- Regression check — `src/web-vue/pages/Landing.vue` still carries the guard on
  shuffle (`:91`), prev (`:95`), play/pause (`:98`), next (`:102`), repeat (`:105`),
  progress bar (`:79` via `aria-disabled` + `seek()` guard at `:27`) and volume bar
  (`:112` via `setVolume()` guard at `:33`); disconnect strip at `:57`.

### #77 — settings form label/input association — PARTIAL

Every input named in the issue is now programmatically associated via Vue 3.5
`useId()`, but one settings input pair in the same file was outside the issue's file
list and remains unlabelled.

Associated correctly:

- `src/web-vue/components/TextField.vue:5,10-11` — `useId()`, `label :for` / `input :id`.
- `src/web-vue/components/SecretRow.vue:28,51,54,59` — both the edit input and the
  readonly reveal input use the shared `:id`.
- `src/web-vue/pages/settings/SettingsSoloist.vue:39,49,54` — PipeWire `<select>`.
- `src/web-vue/pages/settings/SettingsSnapcast.vue:15,29,30` — config `<textarea>`.
- `src/web-vue/pages/Audio.vue:65-66,99-100,103-105` — `fieldId(name)` per-sink ids.
- `src/web-vue/pages/Webhooks.vue:64-65,68-69` — Default URL and Min Interval.

Gap (drives PARTIAL):

- `src/web-vue/pages/Webhooks.vue:85` — per-event override `<select>` has no
  `for`/`id` and no `aria-label` (only visible option text).
- `src/web-vue/pages/Webhooks.vue:89` — override URL `<input>` has no `for`/`id` and
  no `aria-label` (only a `placeholder`).

This is the same defect class as #77, in the settings form, missed because the row
wasn't in #77's file list. Filed as a new issue (see below).

---

## Tests

### #75 — unhandledRejection self-test — FIXED

The test no longer touches the suite-wide `failed` tally; it isolates the assertion
on a scoped listener.

- `src/selftest.ts:2945-2970` — test "unhandledRejection handler surfaces detached
  faults":
  - `:2949-2952` saves and removes the current global `unhandledRejection` listeners.
  - `:2953-2955` installs a scoped one-shot listener (`caught = reason`).
  - `:2958` triggers `void Promise.reject(new Error("detached-boom"))`.
  - `:2962-2964` (`finally`) removes the scoped listener and restores the saved global
    handlers.
  - `:2966-2969` asserts on the scoped `caught` var only — no read or reset of `failed`.
- The global backstop is intact: `src/selftest.ts:225-229` still does `failed++` on
  any unhandled rejection during a real run, and is the exact handler restored in the
  `finally`. No `failed = before` / reset pattern remains anywhere in the file.

Both halves of the acceptance criterion hold: a genuine detached rejection still
increments `failed` (backstop, guaranteed restored), and the suite-wide counter is no
longer reset.

---

## Architecture / code quality

### #76 — wire-contract dedup (ClientMeta, RelayStatus) — FIXED

Each type now has exactly one declaration, in `src/wire-contract.ts`; every other
occurrence is an import, re-export, or usage.

- `ClientMeta` — sole declaration `src/wire-contract.ts:36`.
  - `src/hub.ts:8` import, `:26` `export type { ClientMeta }` re-export, `:49,96,148`
    usage; `src/proxy.ts:18` import, `:20` re-export;
    `src/web-vue/composables/useAppControl.ts:2` import, `:13` re-export;
    `src/selftest.ts:1003,1075,1120` usage via the `hub.js` re-export.
- `RelayStatus` — sole declaration `src/wire-contract.ts:20` (4-field: `enabled`,
  `connected`, `lastConnectAt`, `lastError`).
  - `src/relay.ts:12` import, `:19` re-export, `:27` usage; `src/proxy.ts:12` import,
    `:88` usage; `src/web.ts:10` import, `:100,312` usage;
    `src/web-vue/lib/menuStatus.ts:5` import (was a local 2-field declaration);
    `src/web-vue/pages/settings/SettingsRelay.vue:8` import (was a local 3-field
    declaration), `:13` usage reconciled to the 4-field shape.
- Typecheck clean: `npx tsc --noEmit` (backend) and `npm run typecheck:web` both exit 0.

---

## Carry-overs (still open, not scoped for a fix here)

### ARCH-L5 — selftest monolith — STILL-OPEN

- `src/selftest.ts` is **2979 lines**, a single undivided file (was ~2971 at the
  original re-review; +8, no decomposition). Still a monolith.

### UX-M2 — silent secret-reveal failure — STILL-OPEN

- `src/web-vue/components/SecretRow.vue:40-46` — `view()` calls `revealSecret(...)`;
  on failure `catch { /* leave masked */ }` — no error state, no toast, no visible
  change.
- `src/web-vue/composables/useConfig.ts:187-190` — `revealSecret` makes a bare `api()`
  call with no `fail(...)` on error, unlike `restartSoloist`/`restartSnapcast`
  (`useConfig.ts:170-183`) which surface errors via `fail()` (`:106,109`). A failed
  reveal is invisible.

### TEST-L3 — snapserver restart untested — STILL-OPEN

- `src/snapserver.ts:55-68` — `restartSnapserver(cfg)` invokes `execFile(S6_SVC,
  ["-r", SNAPSERVER_SERVICE], ...)`; `snapcastNeedsRestart` at `:37-45`.
- `src/selftest.ts` imports only the pure conf helpers (`:23`); it never references
  `restartSnapserver` or `snapcastNeedsRestart`. Tests at `:764-787` and `:1581-1609`
  exercise only conf rendering / file write, never the `execFile`/s6-svc restart path
  (success or failure). No coverage.

---

## New issues

- **Per-event webhook override inputs are unlabelled** (filed as #79).
  `src/web-vue/pages/Webhooks.vue:85` (override `<select>`) and `:89` (override
  `<input>`) have no `for`/`id` association and no `aria-label` — same defect class as
  #77, in the settings form, missed because the row wasn't in #77's file list. This is
  why #77 is marked PARTIAL.

## Test run note

Backend self-test on this workspace: `66 passed, 1 failed, 9 skipped`. The single
failure — `first-run setup gating` (`GET /setup` expected 200, got 404) — is
pre-existing and environmental (workspace Node v22 vs the repo's required >=24), not
related to any item above. The unhandledRejection test passes.
