# Shared LoadingState component for consistent detail-pane loading treatment

The web UI (ADR-0014) had three inconsistent loading treatments across detail panes:
- SettingsSoloist, SettingsRelay, SettingsWeb, SettingsSnapcast rendered a tiny uppercase `.lbl` micro-label "Loading…"
- Webhooks used `.lbl` identically
- Audio rendered a centered `.empty` paragraph; Lyrics had **no loading state** until its data arrived

Each detail pane hand-rolled the markup, and the absence of a loading treatment in Lyrics left
users staring at a blank pane unsure whether the app had frozen. This resolved issue UX-M7.

## Decision

A new shared `LoadingState.vue` component at `src/web-vue/components/` renders a centered
animated loading state: a 26px teal spinner ring (border-top-color `var(--ind)`), 0.7s linear
rotation (slowed to 1.6s under `prefers-reduced-motion`), plus a "Loading…" label below the
spinner. The component uses only design tokens (`--ind`, `--line2`, `--faint`) and includes full a11y markup:
`role="status"` and `aria-live="polite"` so assistive tech announces the loading state without
user interaction.

LoadingState is now used in SettingsSoloist, SettingsRelay, SettingsWeb, SettingsSnapcast,
Webhooks, Audio, and Lyrics — replacing ad-hoc markup and filling the gap in Lyrics.

## Consequences

- All loading states are now **visually consistent** (single spinner style and color) and
  **accessible** (a11y attributes baked in) with a single source of truth: LoadingState.vue.
- The `.lbl` micro-label class and `.empty` paragraph styling are no longer overloaded for
  loading; they are now reserved for their primary purposes (section labels and empty-state
  messages). New detail panes default to LoadingState, not hand-rolled divs.
- The spinner respects `prefers-reduced-motion`, so users who prefer reduced motion see a
  gentle slow rotation (1.6s) rather than a fast spin — still legibly "working", not frozen.
