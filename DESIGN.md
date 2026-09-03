# Design — Soloist Proxy

Visual system for the Proxy's web surfaces: Landing Page, first-run Setup, Login, Lyrics
Overlay. Direction: **Clean & Light** — warm off-white ground, teal accent, rounded cards,
airy spacing; a calm, legible operator console (Operate mode), with restrained liquid-glass
accents on the now-playing hero and the Setup/Login cards.

**This is the visual source of truth for `src/web/` — build to it.** Hi-fi mockups (one file
per surface) live in `docs/design/mockups/`; see `docs/design/README.md` for which mockup maps
to which ticket. Live canvas: https://claude.ai/code/artifact/81422f63-4fe6-437a-b7f6-240435f7f5b7

## Tokens

```css
:root{
  /* ground */
  --bg:#f6f6f4; --card:#ffffff; --sub:#fbfbf9; --line:#e9e9e5; --line2:#dcdcd7;
  /* text */
  --txt:#1b1b1a; --dim:#6d6d68; --faint:#9a9a94;
  /* accent (teal) */
  --ind:#0d9488; --ind-h:#0f766e; --ind-s:#e2f5f1;
  /* status */
  --ok:#16a34a; --ok-s:#eafaf0; --bad:#dc2626; --bad-s:#fdeaea;
  --warn:#b45309; --warn-s:#fdf3e7;
  /* type */
  --sans:'Instrument Sans',system-ui,sans-serif;   /* body + UI */
  --disp:'Space Grotesk',system-ui,sans-serif;     /* headings, wordmark, numerics */
  /* elevation */
  --sh:0 1px 2px rgba(20,20,20,.05); --sh2:0 12px 40px rgba(30,30,40,.10);
}

/* Liquid-glass accents — use sparingly (topbar, hero, auth cards), never on every card */
.glass{background:rgba(255,255,255,.55);backdrop-filter:blur(18px) saturate(1.4);
  -webkit-backdrop-filter:blur(18px) saturate(1.4);border:1px solid rgba(255,255,255,.7);
  box-shadow:var(--sh2), inset 0 1px 0 rgba(255,255,255,.85)}
.glassbar{background:rgba(250,250,248,.68);backdrop-filter:blur(14px) saturate(1.3);
  -webkit-backdrop-filter:blur(14px) saturate(1.3);border:1px solid rgba(255,255,255,.6);
  box-shadow:0 4px 22px rgba(30,30,40,.06), inset 0 1px 0 rgba(255,255,255,.9)}
/* Glass needs something behind it: page paints two low-opacity blooms so surfaces refract. */
```

Glass rule: it earns depth only against the ambient blooms and only on a couple of surfaces —
the topbar, the now-playing hero, the Setup/Login cards. Data cards (outputs, webhooks, config)
stay solid `--card` for legibility and to keep the page from reading as AI-slop glass soup.

Fonts via Google Fonts (`Instrument Sans` 400/500/600, `Space Grotesk` 500/600/700), each
with a `system-ui` fallback. Avoid Inter/Roboto/Arial.

## Type ramp

- Page/section heading: `--disp` 700, 17–25px, letter-spacing −.015em.
- Body: `--sans` 400/500, 14px.
- Section label (`.lbl`): `--sans` 600, 11px, uppercase, letter-spacing .07em, colour `--faint`.
- Numeric/time readouts: `--disp` or `--sans` 600, tabular where it matters.

## Spacing, radii, shape

- Base unit 4px. Card padding 20–22px; page padding 26–32px; grid gap 16–18px.
- Radii: cards 16, controls 10–12, pills 20, inner previews 12.
- Borders: 1px `--line` (dividers/cards), `--line2` (inputs). Shadow `--sh` on cards, `--sh2`
  on floating panels (Setup/Login).

## Components

- **Button** `.btn`: 13px 600, radius 10, `--card` bg + `--line2` border; hover → indigo
  border+text. `.btn.pri`: indigo fill, white; hover `--ind-h`. Icon+label gap 7px.
- **Status pill** `.pill`: 12px 600, radius 20, soft-tinted bg + solid fg per status
  (`--ok-s`/`--ok`, `--bad-s`/`--bad`, `--warn-s`/`--warn`, `--ind-s`/`--ind`); leading dot 8px.
- **Toggle** `.sw`: 38×22 track, 18px knob. On = `--ind`; off = `#e0e0db`.
- **Field**: `--sub` bg, `--line2` border, radius 10–11, 12–14px pad. Read-only variant
  `.field.ro` (`#f1f1ee`, `--dim`) for sharp/file-only values, prefixed by a small lock label.
- **Card**: `--card`, 1px `--line`, radius 16, `--sh`.
- **Banner** (pending restart): `--warn-s` bg, `#f0d9a8` border, warning glyph, primary action
  in `--warn`.
- **Side nav item** `.navi`: 13px 600 `--dim`; active `.navi.act` = `--ind-s` bg, `--ind` text.
- **Icons**: inline stroke SVG, 16–19px, 2–2.4 stroke, round caps. No emoji.

## Surfaces

- **Landing Page** — max-width ~1180, centered. Order: topbar (wordmark, status pills, user
  menu) → pending-restart banner (conditional) → **player cluster** (now-playing hero +
  up-next queue, side by side) → 3-col grid (Audio outputs · Webhooks+status · Overlay) →
  Configuration card (left nav + panel; sharp fields read-only under a lock label) → footer
  (WebSocket, Snapweb, secret set/unset pills). **Elevation discipline:** the player cluster
  is the one elevated moment; the topbar sits bare on the page ground, the three data sections
  live in a *single* panel split by vertical hairlines (not three cards), and the config
  editor is the one other card — avoid boxes-within-boxes (read-only values are plain
  label/value, not boxed fields).
- **Player cluster** — the hero and the queue share one row so neither wastes horizontal
  space. Hero ~1.7fr; the **Up next** queue is a matching dark rail (~1fr, min 330px) with a
  count badge, "Clear", and compact rows (index, art thumb, title, artist, duration,
  hover-revealed remove `.qxd`). Fed by the Soloist WS `queue_changed` state event
  (confirmed in `src/proxy.ts`).
- **Now-playing hero** — the deliberate focal point: a dark, immersive panel (deep
  indigo→plum) contrasting the light page, with teal/cyan colour blooms (teal top-left,
  cyan bottom-right), a glossy album tile, quality/source chips, a **slim teal progress bar**
  (round handle), and circular transport (shuffle · prev · large teal-gradient play · next ·
  repeat) with a teal volume track. This is the one dark surface — everything else stays light.
- **First-run Setup** — centered ~440 card on tinted ground. Admin username + password + confirm
  only, primary CTA, an indigo info note ("saved to config.yaml; everything else after
  sign-in"), and a 3-step progress (Admin → Sign in → Configure).
- **Login** — centered ~400 card, username + password, single primary CTA; focus ring =
  `--ind` + `--ind-s` glow.
- **Lyrics Overlay** — transparent background (over any scene). Bottom-centered stack: current
  line large in `--disp` 700 white with a soft glow + subtle dark text-stroke; adjacent lines
  ~26px at .34 opacity. Optional now-playing chip bottom-left (blurred dark glass). Anchor,
  size, colour, effect all driven by the Overlay Config.

## Conventions

- Never render a secret value — show a set/unset pill or masked field with a Replace action.
- Theme is committed light; if a dark mode is ever added, define it as token overrides only.
- Static mockups here; interaction/wiring lands in the T2/T10 build tickets.
