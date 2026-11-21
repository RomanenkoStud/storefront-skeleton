# Lorem Store design system

Storefront first. Source of truth for values: `apps/web/src/tokens.css` (custom properties only, imported before the admin and storefront stylesheets in `main.jsx`). This file gives the roles and the rules. Enforced by `npm run check` (`tools/design-tokens-check.mjs`): storefront CSS may not hold a raw hex colour or a px `font-size`; a new value needs a new token and a reason here. Admin CSS (`styles.css`) has an older palette and is out of scope for now.

Status: tokens and check are in place (phase 1). Existing storefront CSS is not migrated yet; the check exempts it through a LEGACY allowlist that phase 2 empties.

## Colour

Four families, one loud colour.

| Token | Value | Role |
|---|---|---|
| `--graphite-950` | `#151917` | announcement bar, deepest surface |
| `--graphite-900` | `#1b201d` | header, footer, rack room, primary button |
| `--graphite-800` | `#242d24` | raised dark surface, dark buttons and chips |
| `--graphite-700` | `#3b423c` | borders on dark |
| `--ink-900` | `#222722` | body text on light |
| `--ink-muted` | `#626861` | secondary text on light (4.9:1 on paper) |
| `--cream-100` | `#f7f7f2` | page and catalog surface |
| `--cream-200` | `#eeefe9` | manifesto band, text on dark |
| `--cream-300` | `#e7e9e0` | editorial band |
| `--cream-50` | `#f1f3ea` | logo cream |
| `--paper-0` | `#ffffff` | product photo stage, inputs |
| `--line-200` | `#dcded8` | borders on light |
| `--sage-200` | `#cad2c0` | soft hairlines on light cards |
| `--moss-700` | `#33412f` | campaign band surface |
| `--moss-500` | `#51614d` | two-tone headline, icons on light |
| `--moss-300` | `#9eaf90` | muted text on dark |
| `--lime` | `#d7f16c` | the only loud colour: ticker, rules, count badge, focus on dark |
| `--danger` | `#9a2c1f` | errors, sold out |
| `--warning` | `#8a5a00` | cabinet status only: usage near a limit, renewal due within 30 days (amber text 5.9:1 on paper; the palette had no warning tone) |
| `--focus-light` | `#6c7d44` | focus ring on light |

Naming note: the draft names `--ink`, `--line` and `--paper` are already defined (with other values) by `styles.css` and the admin shell, and a later `:root` would override them, so the storefront tokens are `--ink-900`, `--line-200` and `--paper-0`. Do not redefine the old names.

Semantic aliases: `--surface`, `--surface-dark`, `--text`, `--text-on-dark`, `--accent`, `--border-light` (not `--border`: `styles.css` reads `var(--border)` for admin borders).

Brand tokens (read from the logo SVGs): `--brand-stroke-on-light` `#1b201d`, `--brand-stroke-on-dark` `#f1f3ea`, `--brand-fill-on-light`, `--brand-fill-on-dark`, `--brand-fill-small` `#51614d` (S1 on light), `--brand-fill-small-dark` `#d7f16c` (S1/N1 small on dark).

## Type

Two families and one mono. `--font-display` Oswald: headlines, logo, poster prices, always uppercase. `--font-text` DM Sans: everything else. `--font-mono`: the rack readout only.

Scale, nine steps: `--text-2xs` 10, `--text-xs` 11 (eyebrows, card meta, uppercase tracked), `--text-sm` 13 (nav, buttons, secondary), `--text-md` 15 (body, card title, price), `--text-lg` 18 (lead), `--display-sm` 24, `--display-md` clamp(32, 3.6vw, 52), `--display-lg` clamp(38, 5.2vw, 76), `--display-xl` clamp(48, 7vw, 100) (manifesto only). Tracking: `--tracking-caps` .12em, `--tracking-button` .04em, `--tracking-display` -.02em. Leading: `--leading-display` .98, `--leading-text` 1.6.

## Space, shape, icons, motion, layers

- Space on a 4 px base: `--space-1..9` = 4, 8, 12, 16, 24, 32, 48, 64, 96. `--gutter` is the page side padding, `--band-max` 1600 px. Breakpoints (documentation only, custom properties cannot be used in `@media`): 650, 900, 1200.
- Manager UI breakpoints (separate from the storefront's 650/900/1200): phone `max-width: 639.98px`, tablet `640px` to `1023.98px`; desktop `1024px` and up never changes. Mobile rules live only in `apps/web/src/admin-mobile/*.css`, inside the phone or tablet range, every selector starting with `.admin-shell` (guarded by `tests/frontend/admin-mobile-css.test.js`).
- Shape: the storefront is square. `--radius-0` for buttons, cards, inputs, tiles. `--radius-pill` only for the count badge and dots. `--border-1` 1 px.
- Icons: one set on a 24-unit viewBox, `--icon-stroke` 1.6, round caps and joins. Sizes `--icon-sm` 18, `--icon-md` 22, `--icon-lg` 26. Touch target `--hit` 44 px.
- Motion: `--dur-fast` 140 ms, `--dur-base` 200 ms, one easing `--ease`.
- Layers: `--z-sticky` 50, `--z-overlay` 100.

## Logo

Confirmed family (lead round-3 decision: B1 primary, S1 small cut, N1 monogram, "N1 · S between the rules"):

- **B1, fine-line outline: the primary logo, everywhere.** Outline stroke is 4 units in the 294.52 x 150 viewBox (about 4% of letter height). `--brand-stroke-on-light` on light, `--brand-stroke-on-dark` on dark.
- **S1, filled stacked small cut: at small sizes** where the outline would fill in (footer line, small chips, narrow headers). Moss accent on light, lime on dark.
- **N1, monogram:** where only a mark fits (avatar, favicon source). Stroke is 3 units on a 100-unit artboard.
- **The one-line compact logo is rejected** ("looks bad for all cases"). Do not use it in any context.
- The header keeps the current stacked wordmark until the brand SVGs ship.

Planned (wave 3, not in the repo yet): brand SVG files in `apps/web/public/brand/`, the favicon set, `og.png`, a React `Brand` component and the product-template reuse.

## Rules

Bands: each band has one job and sits on one surface. Order is dark rack room, moss campaign band, light catalog, so the light changes between bands. Anything new is its own band or a single tile inside the grid; nothing goes on the wall and the manifesto stays as it is.

One loud colour: lime is the only accent. Use it for the ticker, rules, the count badge and focus on dark. Not for body text, large fills outside a poster tile, or on light surfaces with low contrast.

Icons: one set, stroke 1.6, 24 grid, round caps; no mixed stroke widths and no text glyph arrows (use the icon).

Voice: facts, not slogans. Counts, prices and brand names come from loaded catalog data (prices through `formatPrice`); never hardcode them. Delivery facts only where the code supports them (Nova Poshta branch or parcel locker, a manager confirms by cart code). Payment and returns stay marked placeholders until the lead gives terms. Do not invent.

Do:
- Reference tokens by name; add a token with a reason when none fits.
- Keep radius 0, one stroke width, two fonts.
- Keep text at 4.5:1 or better, hit areas at 44 px.

Don't:
- Write a raw hex colour or a px font size in storefront CSS (the check fails it).
- Add a second accent colour, a new radius or a new icon style.
- Use the one-line compact logo.

## Phase 2 notes (for the lead)

The check's `LEGACY_ALLOWLIST` lists the files still to migrate (streetwear.css, featured-rail.css, landing/announcement.css, card-caption.css, page-ending.css, and the wave-2 visual files header.css, campaign.css, posters.css, delivery.css). Phase 2 maps their raw values to tokens, removes each file from the list, and decides the lime consolidation: the CSS holds `#d7f16c`, `#d7f36b`, `#c9f27a` and `#d4ff43`; `--lime` is `#d7f16c` (the logo lime, and 2 units from `#d7f36b`, which is invisible). `#c9f27a` and `#d4ff43` differ visibly and need a lead call. Moving the 35+ px font sizes onto the nine steps will change some sizes by a pixel or two.

Note: `streetwear.css` also contains admin rules (for example `.admin-shell`), so it is scanned as storefront; admin-only rules in it are migrated or split out in phase 2. Coverage is every CSS file under `apps/web/src` except `styles.css` (the explicit ADMIN list) and `tokens.css`; `delivery/np-picker.css` is on the legacy list too.
