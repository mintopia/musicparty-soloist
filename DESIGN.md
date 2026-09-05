# Design — Soloist Proxy

Visual system for the Proxy's web console: **Now Playing**, **Lyrics**, **Settings**
(master-detail), **Debug**, plus **Login**/**Setup** and the transparent **Lyrics Overlay**.
It is an **Operate**-mode operator console — scanability, consistency, and native expectations
outrank expression; brand lives in precise details.

Direction: a calm, legible console with **two committed themes**:

- **Light — "Clean & Light":** warm off-white ground, teal accent, rounded cards, airy spacing.
- **Dark — "Cold Glass":** a cold slate/ink ground under cyan/teal ambient blooms; data cards
  are translucent glass that **lift** off the ground; the now-playing hero is a deep cold-ocean
  panel. Deliberately cold (blue-cold), never warm charcoal.

**This is the visual source of truth for `src/web-vue/` — build to it.** The SPA is a
multi-page app (vue-router, history mode); the shipped implementation is authoritative for
structure. The static mockups in `docs/design/mockups/` predate the master-detail redesign and
are historical reference for tokens/mood only.

## Tokens

Light on bare `:root`; dark redefines the same token names under `:root[data-theme="dark"]`
(pre-paint bootstrap in every HTML shell — `index/login/setup.html` — sets `data-theme` from
`localStorage['soloist-theme']` before first paint, so no theme flash and **all** surfaces,
auth included, honor the choice).

```css
:root {
  /* ground (light) */
  --bg:#edece8; --card:#ffffff; --sub:#fbfbf9; --line:#e9e9e5; --line2:#dcdcd7;
  --txt:#1b1b1a; --dim:#6d6d68; --faint:#78776f;              /* --faint clears AA on labels */
  --ind:#0d9488; --ind-h:#0f766e; --ind-s:#e2f5f1; --link:#0f766e;  /* --link = AA-safe teal text */
  --ok:#16a34a; --ok-s:#eafaf0; --bad:#dc2626; --bad-s:#fdeaea; --warn:#b45309; --warn-s:#fdf3e7;
  --sans:'Instrument Sans',system-ui,sans-serif;   /* body + UI */
  --disp:'Space Grotesk',system-ui,sans-serif;     /* headings, wordmark, numerics */
  --sh:0 1px 2px rgba(20,20,20,.05); --sh2:0 12px 40px rgba(30,30,40,.10);
  --bar:rgba(255,255,255,.66); --savebar:rgba(255,255,255,.82);   /* docked glass chrome */
}
:root[data-theme="dark"] {
  --bg:#0b0f16; --card:#161e2b; --sub:#10161f; --line:#273241; --line2:#37455a;   /* cold slate */
  --txt:#eef2f8; --dim:#a8b6c8; --faint:#8695a8;
  --ind:#2dd4bf; --ind-h:#5eead4; --ind-s:rgba(45,212,191,.18); --link:#5eead4;
  --ok:#4ade80; --bad:#fb7185; --warn:#fbbf24;   /* + soft-tint *-s variants */
  --sh:0 1px 2px rgba(0,0,0,.5); --sh2:0 16px 46px rgba(0,0,0,.55);
  --bar:rgba(18,25,36,.58); --savebar:rgba(18,25,36,.66);
}
```

**Ambient blooms** — the body paints low-opacity teal/cyan radial clouds (colder + larger in
dark) so glass surfaces have something to refract. Glass never floats over a flat fill.

**Card elevation, per theme:**
- Light: solid `--card` with a soft `--sh`. Data cards stay solid for legibility.
- Dark: a translucent light film (`rgba(148,163,184,.06–.13)`) over a semi-opaque slate, blurred,
  with a bright top hairline (`inset 0 1px 0 rgba(255,255,255,.12)`) and a real dropped shadow.
  The film is **lighter than `--bg`**, so cards read as *raised* — never darker than the ground.

Fonts via Google Fonts (`Instrument Sans` 400/500/600, `Space Grotesk` 500/600/700), each with a
`system-ui` fallback. Avoid Inter/Roboto/Arial.

**Browser surfaces** are themed from the palette: `::selection`, caret, `accent-color`, and
custom scrollbars all use `--ind`/`--line2` — never browser defaults.

## Type ramp

One ramp, applied everywhere — do not introduce a section heading at a page-title size (the
master-detail makes any drift obvious side-by-side).

- **Hero title** (Now Playing): `--disp` 700, 30px, −.02em. Marquee-scrolls when it overflows.
- **Page title** (Debug, auth cards): `--disp` 700, 22px, −.015em.
- **Section / card title** (`SectionCard`, every Settings detail, Debug/Lyrics panels):
  `--disp` 700, **16px, −.01em**. This is the single card-title size — all detail sections match.
- **Body / UI:** `--sans` 400/500, 14px.
- **Section label** (`.lbl` / `.flabel`): `--sans` 600, 11px, uppercase, .07em, `--faint`/`--dim`.
- **Numeric / time readouts:** `--disp` or `--sans` 600, tabular where it matters.

## Spacing, radii, shape

- Base unit 4px. Card padding 22px; page padding 24–30px; grid gap 16–18px.
- Radii: cards 16, controls 10–12, pills 20, hero/queue 20.
- Borders: 1px `--line` (dividers/cards), `--line2` (inputs). `--sh` on cards, `--sh2` on floating
  panels (menu, auth). Declare elevation once — never a 1px border under a wide soft shadow.

## Components

- **Button** `.btn`: 13px 600, radius 10, `--card` bg + `--line2` border; hover → teal. `.btn.pri`:
  teal fill, white; hover `--ind-h`.
- **Status pill** `.pill`: 12px 600, radius 20, soft-tint bg + solid fg per status; leading dot 8px.
  Teal-on-tint text uses `--link` (not `--ind`) for AA.
- **Toggle** `.sw`: 38×22 track, 18px knob. On = `--ind`; off = `#d7d7d1` (light) /
  `rgba(255,255,255,.16)` (dark). Never a hardcoded light hex in dark.
- **Field**: `--sub` bg, `--line2` border, radius 10. Read-only `.field.ro` token-driven per theme.
- **Card** `.card` / **SectionCard**: `SectionCard` is the one card-title primitive — `title` +
  optional `subtitle` + optional `#action` slot (right-aligned, e.g. Audio's "Refresh sinks").
  Every Settings detail section renders through it, so titles are identical.
- **Master-detail sidebar** `.navi`: 13px 600 `--dim`; active `.navi.act` = `--ind-s` bg,
  **`--link`** text. Sticky column on desktop; a horizontal scroller on mobile.
- **Banner** (pending restart): `--warn-s` bg, warning border, primary action in `--warn`.
- **Marquee**: single-line ping-pong scroll for overflowing titles (hero + mini-player), with a
  both-edge fade mask applied **only while overflowing**. Honors `prefers-reduced-motion`.
- **Icons**: [Phosphor](https://phosphoricons.com) via `@phosphor-icons/vue` (ADR-0021), sized
  16–19px in chrome/controls. **`weight="fill"` everywhere**, except the brand mark
  (`PhMusicNotesSimple`, `weight="bold"`). Never hand-author inline SVGs or use emoji/Unicode
  glyphs; external links carry a `PhArrowUpRight` glyph. Named icons in use include
  `PhSpotifyLogo` (Soloist), `PhSpeakerHifi` (Audio), `PhBroadcast` (Snapcast),
  `PhWebhooksLogo`, `PhPlugs` (relay), `PhLock` (web access), `PhTerminal` (Debug).

## Surfaces & navigation

**Top bar** (sticky, glass `--bar`): wordmark · nav · mini-player · menu. **Top-level nav is four
items: Now Playing · Lyrics · Settings · Debug.** The active tab is prefix-matched (a
`/settings/*` deep-link lights **Settings**). **Snapweb** and the theme toggle / log-out /
live-status live in the **hamburger menu**. **On mobile (< 860px) the bar collapses to
hamburger-only** — the nav sections move into the menu; the mini-player is hidden.

- **Now Playing** (`/`) — the **hero** (deep cold-ocean panel in dark; deep indigo→plum in light —
  the one elevated focal surface, with teal/cyan blooms, glossy tile, slim teal progress + round
  handle, circular transport, teal volume) stacked above the **Up next** dark queue rail (count
  badge, art thumb · title · artist · duration rows). Centered ~720 column.
- **Lyrics** (`/lyrics`) — Overlay config (Layout / Text / Motion&FX) beside a **live preview** on
  a transparency checkerboard showing the real karaoke render.
- **Settings** (`/settings`) — **master-detail**: a `.navi` sidebar (Title-Case labels: Soloist ·
  Audio Outputs · Snapcast · Webhooks · WebSocket Relay · Web Access; Audio/Snapcast hidden in
  standalone) and a
  `<router-view>` detail pane. Each section is a deep-linkable route (`/settings/<section>`, served
  by the SPA on hard reload) rendering one `SectionCard`. `/settings` redirects to the first section.
- **Debug** (`/debug`) — dense operator readouts: frame stream (with empty state), client list
  (IP · tier pill · auth · uptime · user-agent), webhook delivery log (status pill · event ·
  latency ms · timestamp). Monospace for data/measurement only.
- **Login / Setup** — centered auth card (`AuthShell`), 22px title, single primary CTA. Honors the
  dark theme via the shell's pre-paint bootstrap.
- **Lyrics Overlay** — transparent; bottom-centered stack, current line large `--disp` 700 white
  with glow + dark stroke, neighbours dimmed. Anchor/size/colour/effect from the Overlay config.

## Conventions

- Never render a secret value — show a set/unset pill or masked field with a Replace action.
- **Both light and dark are committed themes** (default light; the user opts into dark, persisted
  in `localStorage['soloist-theme']`). Dark is a full palette + glass treatment, not token
  overrides alone — but it reuses every token *name*, so components stay theme-agnostic.
- Teal used as **text** (links, active nav, pills) uses `--link`; teal as a **fill** uses `--ind`.
- One card-title size (16px) across all detail sections — route new config surfaces through
  `SectionCard`, never a bespoke `<h1>`.
