# The Web UI is a Vue 3 + Vite single-page app; the server stays buildless

The Landing Page and the login/setup pages move from hand-written vanilla ES
modules — imperative `getElementById` render-and-poke, per-view `build*` string
templates, inline-hex styling — to a Vue 3 SPA: Composition API with
`<script setup lang="ts">`, vue-router in history mode, plain composables for state
(no Pinia), and the `DESIGN.md` tokens exposed as `:root` CSS variables consumed by
Vue scoped styles. It is built with Vite. The imperative render loop was slow to
extend, bug-prone (hand-synced DOM), and read badly — the work a framework does for
free was already being written by hand (`state` + `markDirty()` + `renderView()`).

The **Lyrics Overlay** (`overlay.html` / `overlay.js`) stays vanilla: no framework
runtime is loaded on the unauthenticated, perf-sensitive, rAF-driven lyric-timing
page, which gains nothing from a component model and would only risk its timing.

This introduces a frontend build step — the thing ADR-0004 deliberately avoided.
That rationale is now scoped to the **server** runtime only (see the amendment on
ADR-0004). ADR-0007 (the Proxy serves the Web UI) is unchanged: only the build of
the served assets changes.

## Considered Options

- **Refactor the vanilla UI in place** (extract a small render helper, tokenise the
  inline hex): smallest change, keeps the buildless pipeline — but it does not fix
  the root fatigue, the imperative reactivity. You keep hand-syncing every field on
  every change. Rejected: treats the symptom, not the cause.
- **React / Preact**: most boilerplate (hooks, dependency arrays) for a five-view
  app, heaviest realistic runtime. Rejected: least payoff at this size.
- **Svelte**: smallest output and least code — genuinely attractive for a
  self-hosted appliance — and closest to ADR-0004's minimal spirit. Rejected on
  temperament: Vue's ubiquity, ecosystem, and the maintainer's fluency fit this
  project's conservative, boring-by-choice bias better.
- **Vue 3 + Vite** (chosen): idiomatic reactive rendering, first-class TypeScript,
  scoped component styles, a tiny multi-page build, and a mental model that maps 1:1
  onto the hand-rolled reactivity the code already had.

## Consequences

- **New build step, web layer only.** `build` becomes `tsc && vite build`. Vite
  emits hashed static assets to `dist/web`, which `web.ts` serves unchanged, keeping
  its existing per-path SPA-shell fallback (ADR-0007). Dev is `vite` with HMR,
  proxying `/api` and the control WebSocket to the Node backend.
- **The server runtime is untouched.** Still `ws` + `yaml` as the only *runtime*
  deps, no bundler at runtime — ADR-0004's core promise, now explicitly
  server-scoped. `vue`, `vue-router`, `vite`, and `@vitejs/plugin-vue` are
  build/dev-time only.
- **The Lyrics Overlay stays vanilla**, including its Read-only-Token embed; the
  migration must not touch its rAF lyric timing.
- **The Node-testable seam survives.** Wire-format decoders
  (`readTrack` / `readPlayback` / `fmtTime` / `readQueue`) remain framework-free TS
  modules so `selftest` keeps running them headless in Node.
- **Styling has one source of truth.** `DESIGN.md` tokens become `:root` CSS vars;
  inline hex is removed. No Tailwind — it would fight the existing token system.
- **Docker** gains a `vite build` at image-build time; the runtime image still runs
  `node dist/main.js` with no toolchain present.
