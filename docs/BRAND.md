# S-Tier Brand & Design System

The brand for **S-Tier Utilities** by **S-Tier Building Automation**. The living,
interactive version of this guide ships in-app as the **Design System** tool
(Library -> Design System); this document is the written companion. Tokens live in
[src/styles.css](../src/styles.css) `:root`; the logo mark in [src/ui/brand.js](../src/ui/brand.js).

## Brand story

S-Tier is the integrator's building-automation workspace: discover, model,
commission, analyze, and operate real buildings from one tool. The product should
feel like a precise supervisory **control room** — calm, technical, and
instrument-grade, never noisy or toy-like.

## Voice

**Precise. Field-ready. Open.**

- Precise: exact, quantitative, no fluff. Say "117 points, 2 controllers", not "lots of stuff".
- Field-ready: written for a technician on-site. Action-first, plain language.
- Open: standards-first (BACnet, Modbus, Haystack), no walled gardens.

Avoid marketing superlatives, exclamation points, and emoji in product copy (tool
emojis in the catalog are the one exception).

## Logo mark

An ascending four-tier signal-level motif — it reads as "S-Tier" and as an
instrument level meter. The top tier is amber; the rest are signal teal.

- Clear space: keep at least one tier-width of space around the mark.
- Minimum size: 24px.
- Variants: full color on dark; `mono` (currentColor) for single-color contexts.
- Do not recolor the teal tiers, stretch the mark, or place the amber tier on a
  busy background where it loses its "active signal" meaning.

## Color

Calm cool-dark canvas, one confident signal accent, amber strictly for
manual/override/commanded states.

- `--accent` `#14B8A6` — signal teal: primary action, focus.
- `--accent-2` `#2DD4BF` — teal highlight, borders, glow.
- `--signal-amber` `#FBBF24` — manual / override / commanded.
- `--ok` `#34D399`, `--warn` `#FBBF24`, `--error` `#F87171`, `--info` `#38BDF8`.
- Surfaces: `--bg` `#0C0F14`, `--bg-elev` `#141821`, `--bg-elev-2` `#1B212D`.
- Lines/text: `--border` `#2A3140`, `--text` `#E8EDF4`, `--text-dim` `#93A0B4`.
- Focus/active glow: `--glow`.

Rule: teal is the only brand accent; do not introduce new accent hues. Amber is a
signal, not decoration.

## Typography

- Display (`--font-display`, **Archivo** 600/700/800): titles, hero, section heads.
- UI (`--font-ui`, **IBM Plex Sans** 400/500/600): body and controls.
- Data (`--font-mono`, **IBM Plex Mono** 400/500): values, ids, source refs,
  timestamps — anything tabular or addressable.

Fonts are bundled offline under `src/assets/fonts/` (OFL-1.1). Do not add web-font
CDNs. Use the type ramp tokens (`--fs-*`); never hardcode pixel sizes in tools.

## Spacing, radius, motion

- Spacing scale `--sp-1..6` (4px-based) and `--gap`; padding via `--pad-card`.
- Radius `--r-sm/md/lg` (sharp, desktop-grade) and `--r-pill`.
- Motion is restrained: one staggered page-load reveal, soft state glows, hover
  lifts of ~1px. Everything must respect `@media (prefers-reduced-motion: reduce)`.

## Component rules

- Tool pages never render their own header/title/status pill — the shell owns
  that chrome (`src/ui/plugin-page.js`); the lint in
  [src/ui/plugin-chrome-lint.js](../src/ui/plugin-chrome-lint.js) enforces it.
- Status uses the pill scale (`pill-running/idle/muted/warn/error`).
- Reuse tokens and shared classes (`btn`, `btn-primary`, `btn-ghost`, `nm-field`,
  `nm-input`, `muted`, `empty-state`) rather than bespoke styles.

## Do / don't

- Do lead with precise numbers and state. Don't pad with adjectives.
- Do keep one teal accent. Don't reintroduce indigo/purple gradients.
- Do bundle fonts. Don't rely on Inter/system fallback as the brand face.
- Do gate motion on reduced-motion. Don't animate continuously.
