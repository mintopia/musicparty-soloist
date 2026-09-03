# Design reference

The visual source of truth for the Proxy's web surfaces. **Implementation must follow this.**

- **`../../DESIGN.md`** — the design system: tokens (Clean & Light, teal accent), type ramp,
  component specs, per-surface layout, elevation discipline. Copy token values from here
  verbatim; do not re-invent colours/spacing.
- **`mockups/`** — the hi-fi mockups these specs came from, one file per surface:
  - `landing.dc.html` — Landing Page (topbar, restart banner, player cluster = now-playing
    hero + up-next queue, one hairline-divided data panel, config editor, footer)
  - `setup.dc.html` — first-run Setup (admin credentials only)
  - `login.dc.html` — Login
  - `overlay.dc.html` — Lyrics Overlay (transparent, over a sample scene)
  - `canvas.json` — layout of the above on the design canvas
- **Live canvas:** https://claude.ai/code/artifact/81422f63-4fe6-437a-b7f6-240435f7f5b7

## How to use it when building `src/web/`

1. Read `DESIGN.md` first; lift the token block into the stylesheet.
2. Open the relevant `mockups/*.dc.html` for structure and exact styling. These are
   Design-Component artboards: readable as plain HTML for markup/inline styles (ignore the
   `<script src="./support.js">` shim and the sample data — track names, stats, etc. are
   placeholders). Match spacing, radii, colours, and layout; use real data/state in the build.
3. Which mockup maps to which ticket: `landing.dc.html` → T10 (#11); `setup.dc.html` +
   `login.dc.html` → T2/T3 (#3/#4); `overlay.dc.html` → T5 (#6).
4. After building a surface, verify it against the mockup, then run the design detector
   (`node ~/.claude/skills/impeccable/scripts/detect.mjs --json <changed files>`).
