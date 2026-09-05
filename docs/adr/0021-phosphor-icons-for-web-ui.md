# Phosphor Icons is the web UI's icon set

The Vue web UI (ADR-0014) drew every icon as a hand-authored inline `<svg>` — the same
2px round-cap stroke style, but copied per-site across `App.vue`, `AppMenu.vue`,
`MiniPlayer.vue`, `Landing.vue`, `Settings.vue`, `Audio.vue`, `Debug.vue`, `Lyrics.vue`,
and the components. That gave no shared set to pick from, duplicated path data, and let
stroke/size drift between surfaces (the master-detail redesign made the drift visible).

The UI now takes its icons from **[Phosphor Icons](https://phosphoricons.com)** via
`@phosphor-icons/vue`.

- **~9,000 MIT-licensed icons** across six weights (`thin`, `light`, `regular`, `bold`,
  `fill`, `duotone`) — the widest self-hosted set we evaluated, with deep coverage for an
  operator console (audio, hardware, network, signal). The UI standardises on the **`regular`**
  weight for a clean, even stroke close to the previous hand-drawn look; `fill`/`bold` are
  reserved for deliberate emphasis (e.g. an active/pressed transport control).
- **Tree-shakeable named imports** (`import { PhPlay } from "@phosphor-icons/vue"`), so only the
  icons actually used ship in the bundle. Icons inherit `currentColor` and take `:size` /
  `weight` props, set per site to match the old inline dimensions (16–19px in chrome/controls).
- **Self-hosted** (bundled through Vite, never a CDN), so it stays within the app's own origin
  and CSP.

## Consequences

- One dependency (`@phosphor-icons/vue`). Bundle grows only by the icons imported, not the set.
- Icon choice for any new surface comes from the Phosphor set by name; do not hand-author new
  inline SVGs. Keep the `regular` weight and a size matched to the context; reach for another
  weight only when the emphasis is intentional and consistent.
- The **brand wordmark mark** stays a bespoke SVG — it is identity, not an icon.
- Alternatives considered: **Tabler** (~5,900 icons, a closer match to the old 2px stroke) and
  **Lucide** (~1,600, the closest match but the smallest set). Phosphor was chosen for the
  largest self-hosted library and its multiple weights; the trade-off is that its default look
  is marginally softer than the old stroke, addressed by standardising on `regular`.
