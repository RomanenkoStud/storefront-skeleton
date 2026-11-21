# ADR-0014: Fresh-drop hero, retirement of the WebGL spray intro, cart moment and logo slots

Status: **Proposed** (epic "Brand system and fresh-drop hero"). It supersedes [ADR-0009](0009-webgl-spray-intro.md) and all of its amendments. ADR-0009's v5 "Shopfront" amendment was never built and is withdrawn.

The lead answered the wave-3 quiz; the answers are recorded under [Lead answers](#lead-answers) and applied throughout. The main changes from the first draft are:

- the wall band is dropped and `hero-wall.webp` leaves the page;
- logos use T2's minimum sizes;
- the manifest uses `display: browser`;
- capped adds play no cart moment.

The design mockups were working files and are not kept in this repository.

Number: 0010 and 0013 were claimed by branches that never merged. This ADR therefore takes 0014.

## Context

**Lead decisions, round 3 (verbatim summary).**

1. Monogram **N1 · S between the rules**: B1's outline S with the lockup's rules from 48 px up, and the filled M5-style cut at 16 and 32 px.
2. Hero **H4 · Fresh drop**, "the stock is the hero":
   - the three newest pieces take the wall's place in the hero;
   - the WebGL spray intro leaves the hero.
   - Round 3 also moved the wall photo to a band lower down. The quiz answer L-1 later dropped that band.
3. Spray **(c)**: the "added to cart" moment, in style **L2 · Spray line**, a CSS-only line with a lime nozzle dot.
4. Family:
   - B1 fine-line outline is the primary logo;
   - S1, the filled stacked cut, is used at small sizes;
   - N1 is the monogram;
   - outline everywhere;
   - the one-line compact logo is rejected everywhere.

**Approved defaults.**

- Q-a: keep the H4 hero, the rack room (`FeaturedRail`) and the campaign band.
- Q-b: "newest" means `updatedAt` for now. A follow-up adds `listed_at`.
- Q-c (where the wall band goes) is moot after L-1.

**Code facts at the base revision, with the wave-2 branches merged in memory for the mockups.**

- **Spray code.**
  - The intro is `SprayIntro.jsx`, `spray-scene.js`, `spray-paint.js`, `spray-choreo.js`, `spray-can.js`, `spray-run.js`, `spray-intro.js`, `spray-static.js`, `spray-gate.js`, `spray-intro-boot.jsx` and `spray-intro.css`, plus `assets/spray-intro/` (`piece.webp`, `piece-layers.png`, `piece-final.webp`, `README.md`).
  - `main.jsx` imports `./spray-intro-boot.jsx` as a side effect.
  - `three` 0.187.0 is imported only by `spray-scene.js` and `spray-can.js`.
  - Outside the intro, only `Storefront.jsx` imports anything from `spray-gate.js`: `navigationType()`, used by the page-ending hash re-align effect.
  - `catalog-filters.js` `withPreserved()` keeps `?intro=0|1` when the filter URL is rewritten. `CampaignBand.jsx` (wave 2) and `Storefront.jsx` call it, and `tests/frontend/page-ending.test.js` asserts it.
  - At the base, no e2e spec other than `spray-intro.spec.js` uses `?intro` or `html[data-spray-intro-state]`. On the wave-2 integration, `tests/e2e/campaign.spec.js` (wave 2) opens `/?intro=0` and its URL assertion accepts an optional `intro=0&`. Once the param is ignored this is harmless, and the spec stays as it is.
  - **Token check.** The design-token check depends on the intro:
    - `tools/design-tokens-check.mjs` lists `apps/web/src/spray-intro.css` in `LEGACY_ALLOWLIST`, and its test fails on a stale entry;
    - `apps/web/src/tokens.css` defines `--z-intro`, and `tests/backend/design-tokens.test.js` requires it;
    - `docs/design/DESIGN.md` names both.

    New storefront CSS files are enforced at once: no raw hex colours and no px font sizes.
- **Wall photo.** `apps/web/public/editorial/hero-wall.webp` (1536x1024) is referenced only by the hero poster in `Storefront.jsx`, by `SprayIntro.jsx`, by `tests/e2e/spray-intro.spec.js` and by the intro's provenance files.
- **SPA data flow.**
  - `Storefront` mounts only after `TaxonomyProvider` has loaded `/api/taxonomy`. Only then does it fetch `/api/products`, which returns the full public list (`no-store`), computed per request by `publicCatalog` and `withCardPhotos`.
  - The hero poster (`fetchpriority=high`) is rendered by React.
- **Serving.**
  - In production `/` is served by static assets without the Worker: `run_worker_first` lists `/api/*`, `/products/*`, `/media/*` and others, but not `/`.
  - Staging runs the Worker first for everything.
  - `/media/*` is `no-store`, and every card-thumbnail request is authorized with D1 lookups.
  - `/products/:slug` is Worker HTML with no app bundle. Its add-to-cart is a GET form to `/cart?add=…`, and `CartPage` performs that add with `cartStore.addProduct`.
- **Live data, production, read-only.**
  - Most listed items are in stock and have a photo.
  - **No item has `cardPhoto` yet.** The production thumbnail token has not been created, see the runbook in [MEDIA.md](../MEDIA.md#card-thumbnails).
  - First photos include large PNGs and hotlinked supplier JPEGs.
  - `updatedAt` has few distinct values: one sync timestamp is shared by most items. Sync bumps `updated_at` on every upsert, as ADR-0013 Q1 records.
- **Wave-2 slots.**
  - Wave 2: `HeaderLogo()` in `landing/SiteHeader.jsx` is the single logo slot for the full header and the condensed 56 px `.store-bar`. The bar's IntersectionObserver watches `.storefront .hero`.
  - Wave 2: `SiteFooter` has `data-slot="footer-logo"` around `<Brand/>`.
  - `Account.jsx` and `CartPage.jsx` render `SiteHeader`.
  - The Worker product page has its own `HEADER` string. The wordmark is asserted in `tests/backend/product-page.test.js` and in `tests/e2e/product-page.spec.js` (`.brand` `toContainText('STYLE')`).

## Decision 1: retire the WebGL intro and the wall photo

T3 deletes the following. Nothing else imports these files (verified with grep at the base).

| Remove | Notes |
| --- | --- |
| `apps/web/src/SprayIntro.jsx`, `spray-scene.js`, `spray-paint.js`, `spray-choreo.js`, `spray-can.js`, `spray-run.js`, `spray-intro.js`, `spray-static.js`, `spray-intro-boot.jsx`, `spray-intro.css` | The whole lazy and boot path |
| `apps/web/src/spray-gate.js` | Only after `navigationType()` has moved, see the next row. Its other exports (`shouldPlay`, `introParam`, `heroAtTop`, `touchFirst`, constants) die with the intro |
| `navigationType()` | Moves unchanged (same signature and default) to a new `apps/web/src/navigation.js`. `Storefront.jsx` imports it from there |
| `import './spray-intro-boot.jsx'` in `apps/web/src/main.jsx` | |
| `three` in `package.json` | Run `npm uninstall three` so the lockfile changes only through npm. Also drop `tests/frontend/spray-intro.test.js` from the `test` script |
| `apps/web/src/assets/spray-intro/` (`piece.webp`, `piece-layers.png`, `piece-final.webp`, `README.md`) | Unused after the code goes |
| `apps/web/public/editorial/hero-wall.webp` | Unused once the hero figure and the intro are gone (L-1) |
| `apps/web/public/licenses/spray-intro.txt` | It only covers the intro artwork and `hero-wall.webp`, which are all deleted, so no provenance has to move |
| `tests/e2e/spray-intro.spec.js`, `tests/frontend/spray-intro.test.js` | |
| Token-check references (wave 2) | Remove `apps/web/src/spray-intro.css` from `LEGACY_ALLOWLIST` in `tools/design-tokens-check.mjs`. Remove `--z-intro` from `apps/web/src/tokens.css` and from the required list in `tests/backend/design-tokens.test.js`. Update the layer line and the allowlist paragraph in `docs/design/DESIGN.md`. All in the same commit as the CSS deletion, because the test fails on a stale allowlist entry |
| The hero index line `<span className="hero-index">01 / РЕЧІ ДЛЯ ТВОГО ЩОДНЯ</span>` | Removed with the hero figure (absorbs an earlier hero task). The first-screen mockups still show it |
| `?intro` handling in `withPreserved()` (`catalog-filters.js`) | Keep the export and its `(query, search)` signature, now returning `query` unchanged, so that the wave-2 `CampaignBand.jsx` and other callers need no edit. Replace the page-ending test case with "an `?intro` param is no longer carried over". A stale `?intro=` in a URL is ignored |

- **Kept.**
  - `city-layers.jpg` for the editorial section (replaced `night.jpg`).
  - The `Poster` component for the editorial poster. Its `jump-poster` branch and the hero alt text "…на ній напис LOREM STORE" leave with the hero figure.
- **Dead CSS.** The `.jump-poster` and `.hero-art` rules in `streetwear.css` become dead. They stay, because nobody edits `streetwear.css` in this wave; new hero rules go in `landing/hero.css`, which is imported after it. Removing them is a follow-up.
- **Docs.**
  - The homepage motion brief (no longer in the repository): its note points to this ADR.
  - `docs/adr/README.md`: indexes 0014 and marks 0009 superseded (done).
- **Effect, from the logo3 scratch build.**
  - About 347 kB is no longer requested when the intro plays, and about 149 kB when it does not. Phones save up to about 496 kB.
  - The 550 kB of minified script, the WebGL context and the 8.7 s of frames go too.
  - Main entry gzip drops by about 2 kB.
  - The 247 kB wall photo is no longer requested on the landing at all.

## Decision 2: H4 data and LCP strategy

### Options

| Option | For | Against | Outcome |
| --- | --- | --- | --- |
| **A. Worker inlines the three products into `index.html`** (HTMLRewriter at `/`, plus a `<link rel=preload as=image>`) | The image request can start before the bundle runs | Production would have to add `/` to `run_worker_first`, so every landing hit becomes a Worker invocation running `publicCatalog` and the card-photo query, and the SPA requests `/api/products` a moment later, which doubles the work per visit. The shell becomes `no-store` HTML. The inlined data and the API can disagree. The SPA still paints the cards only after the bundle and taxonomy, so the gain is about one thumbnail download. It also adds a second rendering contract | Rejected for now (revisit triggers below) |
| B. A dedicated `/api/products/fresh` endpoint | Small response | The landing already downloads the full list for the catalog, so this is an extra request for data the page already has | Rejected |
| **C. Client-side from the one `/api/products` response, with the request started early and skeletons reserved** | No new request, endpoint or Worker route. The pick uses the same data as the catalog | The hero image waits for one more API round trip than the old poster. Mitigated by starting the request in parallel with `/api/taxonomy` | **Chosen** |

### Decision

- **Early request.**
  - A new `apps/web/src/products-feed.js` exports `loadProducts()`: one memoized promise of `api('/api/products')`.
  - `main.jsx` calls it at module evaluation only when `location.pathname === '/'`. It is not called for admin, staff, account, cart or `/products/*`. The products request then runs in parallel with `/api/taxonomy` instead of after it.
  - **Error handling.** At start the memo attaches a no-op `.catch`, so an early failure is never reported as an unhandled rejection. On rejection the memo is cleared, so the next `loadProducts()` call sends a new request. Callers still receive the rejection.
  - `Storefront` reads the list from `loadProducts()` and keeps its own error and loading state. Retry behaviour is unchanged.
- **Pick rule (L-2: one per category among the newest, confirmed).** A pure `pickFreshDrop(items, count = 3)` in `apps/web/src/landing/fresh-drop.js`. It is deterministic and unit-tested.
  1. Eligible items are:
     - in stock: some variant has `stock > 0`, the same rule as `inStockSizes` and the card's sold-out caption, so sold-out items are excluded;
     - with a first photo (`photos[0]`);
     - priced: `priceMinor` is a safe integer greater than 0.
  2. Sort by `updatedAt` descending, with an invalid date counting as 0, then by `slug` ascending as the tie-breaker.
  3. Pass 1 takes the first item of each category until `count` items are picked. Items whose `categoryId` is `unclassified`, `null` or missing count as one category.
  4. Pass 2 fills the remaining places in sort order.

  With only two categories among the eligible items the result is a1, b1, a2: the newest of each category, then the next newest overall. With only one category it is simply the three newest.

  The distinct-category pass exists because sync timestamps tie in large blocks (most items share one timestamp), so plain "newest" today means "the last supplier synced, ordered by slug". When the `listed_at` follow-up lands, only the sort key changes (`listedAt ?? updatedAt`).
- **Markup.**
  - The hero section keeps `className="hero"` and `#hero-title`, so the sticky bar's observer still works.
  - `<figure className="hero-art">` is replaced by `<section className="hero-drop" aria-labelledby="hero-drop-title">`. It holds an `h2` "Свіжий дроп" and a link "{total} речей у каталозі ↗" to `/#catalog`, where `total` is the number of listed items. Below that come three tile links to `/products/:slug`, each with the brand, title and `formatPrice(priceMinor)`.
  - The hero has no QuickAdd. It stays a shop window; adding to the cart happens on cards and product pages.
- **Images.**
  - `src = cardPhoto ?? photos[0]`; on error, fall back to `photos[0]`, then to the N1 placeholder (Decision 5).
  - Tile images have `alt=""`. Each tile is a link whose visible caption (brand, title, price) is its name, so an alt would repeat it.
  - Tile 0 gets `loading="eager"`, `fetchpriority="high"` and `decoding="async"`. Tiles 1 and 2 get `loading="eager"` with the default priority.
  - Images use `object-fit: contain` on white, as on product cards. Card thumbnails are at most 800 px on the long edge (MEDIA.md), which covers the 445x506 lead tile at 1440 up to DPR 1.6. A larger hero derivative is a revisit trigger, not part of this work.
- **Layout and no layout shift.**
  - **Above 900 px.** The two-column hero stays (`minmax(0,.9fr) minmax(0,1.3fr)`, min-height 570). The right column is a 2x2 grid (`1.25fr 1fr`) in which the lead tile spans both rows.
  - **651 to 900 px.** The existing `.95fr 1.1fr` split stays. T3 verifies 768 and 820 px and may stack the drop below the copy if the tiles are under 200 px wide.
  - **650 px and below.** The drop sits under the copy as a horizontal scroll-snap row of three tiles, each 44% wide and 260 px high (mockup `first-screen-390.webp`).
  - **Loading.** Three skeleton tiles occupy exactly the same grid boxes (`aria-hidden`, no text). Box sizes come from the grid and from `aspect-ratio` or height, never from image dimensions.
  - New hero rules use tokens.
- **Fallback (L-1: copy only).**
  - On an error, or with fewer than 3 eligible items, the hero shows no picture. The wall photo is gone.
  - T3 decides the exact form. For example, the copy column takes the full width, or the right column shows a short typographic panel with a link to the catalog.
  - The fallback never shifts layout against the skeleton it replaces.
- **Accepted (L-3).** The trio overlaps the head of the catalog grid. The default sort is in stock first, then newest, so the picks are among the first cards, although the distinct-category pass can skip some. The grid order does not change.
- **Prerequisite: card thumbnails in production.** Without them the lead tile loads the original photo, up to 2.4 MB. Thumbnails must exist before go-live. The runbook is in [MEDIA.md, "Card thumbnails"](../MEDIA.md#card-thumbnails), and running it against production needs separate lead approval.
- **Pagination.** If ADR-0013 paged mode is ever accepted, the feed becomes a `sort=new&available=1&limit=…` query. The pick rule does not change.

### LCP gate and mitigation

- **Measurement.**
  - T3's lab measurement found LCP at 1440 **1.57 s worse** than the base.
  - The base's LCP element was the `h1`, not the poster, because the intro hid the poster during load. The base number is therefore optimistic for any picture hero.
  - The cause is about 40 lazy rack-room images (`FeaturedRail`) that start in the same window as the lead tile and compete with it for bandwidth.
- **Mitigation, owned by T3.** T3 also owns `apps/web/src/FeaturedRail.jsx` and `apps/web/src/featured-rail.css`, to deprioritise and defer the rail images.
  - Rail images get `fetchpriority="low"`.
  - The rail does not request its images until the hero's lead image has settled, that is loaded or failed, or the hero has fallen back. A short timeout ensures the rail always loads.
  - Images below the first rail view stay lazy.
  - The rail keeps its reserved boxes, so deferring causes no layout shift.
- **Gate.** T3 measures again after the mitigation, on the base and on the branch, at 390 and 1440 (production build, fixture with card thumbnails, Chromium with 4G-like throttling) and reports both numbers.
  - If LCP is still more than 300 ms worse than the base at either width, T3 does not change the design further. The trade-off goes to the lead as a decision: accept, defer the rail further, or reconsider option A.

## Decision 3: page order

**Final order (L-1), below the announcement and the header:**

1. **H4 hero**
2. StreetStrip ticker
3. rack room
4. campaign band
5. catalog
6. editorial poster
7. delivery band
8. footer

- The wall band is dropped entirely. Its task is closed as won't-do.
- The lead accepted the run of rack room, campaign band and catalog. The rack is category navigation and the campaign band is a one-category promotion; both lead into the catalog.
- The earlier option sheets that show a wall band are superseded.

## Decision 4: the cart moment (L2 spray line)

- **Signal, in the cart store.**
  - `createCartStore()` gains `subscribeAdded(listener)`, which returns an unsubscribe function.
  - `addProduct` calls each listener after a successful write, that is for every `isAddOk(status)`, with the payload `{ status, productId, size }`.
  - The signal is not emitted for failed statuses, `refresh()` (another tab), `setQuantity`, `removeLine`, `completeCheckout` or `refreshHints`.
  - Each listener is called in a `try/catch`, so a failing listener never breaks the add.
  - This covers QuickAdd and SizePicker through `addWithFeedback`, and the Worker product page through `CartPage`'s `?add=` flow. `SiteHeader`, and with it `CartLink`, is a child of `CartPage`, so its effect subscribes before `CartPage`'s add effect runs (an acceptance check).
- **Which adds play (L-5).** The moment plays only for `added` and `merged`. A `capped` or `stock_capped` add, where the quantity did not grow as asked, plays no moment. The existing note and live-region text explain it.
- **The rule under the bag.**
  - `CartLink` subscribes in an effect and, for a playing status, increments a counter.
  - It renders `<span className="cart-moment" key={n} aria-hidden="true"><i/><b/></span>` inside the existing 44 px `.cart-link` box (`position: relative`). Changing the key restarts the CSS animation.
  - `<i>` is the rule: absolute, 24 x 2 px, centred under the icon, `var(--lime)`, `transform: scaleX(0 → 1)` from the left over 0.4 s with `cubic-bezier(.55,0,.3,1)`.
  - `<b>` is the nozzle: a 4 px `var(--lime)` dot with a `box-shadow` halo (no `filter`). It moves `translateX(0 → 24px)` in step with the rule and fades out at the end.
  - The rule holds, then fades out (opacity) by **2.4 s** (L-4).
  - The `.cart-count` badge gets a 0.2 s scale pop on the same key.
  - Both bar instances (the header and the sticky bar) animate; only the visible one is seen.
- **The button.**
  - QuickAdd already swaps to `CheckIcon` when done. The tick path gets `pathLength="1"` and is drawn with `stroke-dashoffset` over 0.25 s, for the playing statuses only.
  - SizePicker shows the same tick and the label "У кошику" for 2 s, inside the unchanged full-width button; its `aria-label` is unchanged. SizePicker only renders in the SPA product view, which production never serves (`/products/*` is Worker HTML), so it is a dev and fallback path and needs only this minimal change. Its 2 s label reset may use a timer.
- **CSS only.**
  - All keyframes live in `apps/web/src/cart/cart-moment.css`, written with tokens only (`var(--lime)`, `var(--graphite-900)`, `var(--ease)`). The token check enforces this file from the start.
  - JavaScript only bumps a key. No timer drives the animation itself, there is no `requestAnimationFrame` and no library.
- **Reduced motion.** No scale, draw or translation. The rule appears at full width without the nozzle and disappears at 2.4 s through a stepped opacity change. The tick appears without drawing. The badge does not pop.
- **Accessible status.**
  - No new live region. The existing polite regions already announce `ADD_STATUS_TEXT`: QuickAdd's `sr-only` status, SizePicker's `picker-feedback` and CartPage's own status. A second region would announce twice.
  - `.cart-moment` is `aria-hidden`.
  - `CartLink`'s `aria-label` keeps reporting the count (`cartLabel`).
  - Focus never moves.
- **No layout shift.** Only absolutely positioned children of an existing box are added, and only `transform` and `opacity` are animated. The e2e check sums `layout-shift` entries during an add and expects exactly 0.
- **No Worker change.** The Worker product page needs nothing: its form navigates to `/cart`, where the moment plays on the header bag.

## Decision 5: the logo slot contract

**Naming.** The files are the ones the brand task (T2) delivered in `apps/web/public/brand/`. The suffix names the **surface** the file sits on:

- `-dark` is for dark surfaces: cream `#f1f3ea` (`--brand-stroke-on-dark`).
- `-light` is for light surfaces: ink `#1b201d`. The N1 mark has no suffix for its light-surface file.

B1 and the N1 outline are one colour. Lime appears only in the S1 dark rules and in the N1 filled cut, which sits on a graphite tile. On light surfaces the S1 rules are moss `#51614d`.

**Sizes (L-6: T2's minimums).**

- B1 is never narrower than **120 px**. At its 1.96:1 aspect (viewBox 294.52 x 150) that is **61 px high**.
- S1 is never narrower than **64 px**. At 1.83:1 (viewBox 292 x 160) that is **35 px high**.
- S1 is used where B1 at 120 px wide does not fit; today that is the 56 px sticky bar.
- The N1 outline drawing is used from 48 px up; below that, the filled cut.
- The brand task's size sheets showed these minimums; they are not kept in this repository.

**Files in `apps/web/public/brand/` (delivered).**

| File | Content | Used by |
| --- | --- | --- |
| `logo-b1-dark.svg` | B1 fine-line outline, cream | Full header, footer slot, Worker product-page header |
| `logo-b1-light.svg` | B1, ink | Admin and staff login cards (light) |
| `logo-s1-dark.svg` | S1 filled stacked cut, cream with lime rules | Sticky bar |
| `logo-s1-light.svg` | S1, ink with moss rules | Light slots where B1 does not fit (none today) |
| `mark-n1.svg` | N1 outline, ink, no tile | Photo placeholder on light grey; `<Brand variant="mark" on="light">` |
| `mark-n1-dark.svg` | N1 outline, cream, no tile | Admin sidebar (dark, `#191e1a`); `<Brand variant="mark">` |
| `mark-n1-small.svg` = `favicon.svg` | N1 filled cut on a graphite tile: cream S, lime rules, 16/32 grid | Browser tab, manifest `any` icon, placeholders under 48 px |
| `favicon-32.png`, `favicon-16.png` | Rasters of the filled cut | `<link rel="icon" type="image/png" sizes=…>` fallbacks |
| `apple-touch-icon.png` | 180 px, solid graphite | `<link rel="apple-touch-icon">` |
| `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | Install icons; the maskable icon keeps the monogram inside the safe circle | Manifest only |
| `og.png` | 1200 x 630, B1 on graphite with the tagline | `og:image` in `index.html` |
| `site.webmanifest` | `name`/`short_name` "Lorem Store", `lang` uk, `start_url` and `scope` "/", `theme_color` and `background_color` `#1b201d`; icons `favicon.svg` (`any`), 192, 512, 512 maskable | `<link rel="manifest">`. **`display` becomes `browser` (L-7)**, a one-line change T6 makes to the delivered file (it was `standalone`) |

**Component API (T6, `apps/web/src/ui.jsx`).**

```js
Brand({ variant = 'full' /* 'full' | 'compact' | 'mark' */, on = 'dark' /* 'dark' | 'light' */ })
// <a class="brand brand-{variant}" href="/" aria-label="Lorem Store — головна">
//   <img src="/brand/{file}" alt="" width={w} height={h} decoding="async"></a>
// full    -> logo-b1-{on}.svg   (width 120, height 61 at minimum)
// compact -> logo-s1-{on}.svg   (width 64, height 35)
// mark    -> on === 'dark' ? mark-n1-dark.svg : mark-n1.svg
```

- The `light` prop is removed; its only caller is the admin sidebar.
- The images are not lazy. `width` and `height` give the aspect ratio, so swapping the logo causes no layout shift. The rendered size is set per slot in `landing/brand.css`, using tokens only, and never below the minimums above.

**Slots and sizes.**

| Slot | Mark | Size |
| --- | --- | --- |
| `HeaderLogo` in the full header (`SiteHeader`, also used by Account and Cart) | B1 dark | 120 x 61 px at every width. It fits the 105, 90 and 86 px header heights |
| `HeaderLogo` in the sticky `.store-bar` | S1 dark | 64 x 35 px in the 56 px bar |
| Footer `data-slot="footer-logo"` | B1 dark (`<Brand/>` default, no edit to `SiteFooter.jsx`) | At least 120 x 61 px |
| Worker product page `HEADER` (`apps/api/src/product-page.js`) | `<img src="/brand/logo-b1-dark.svg" alt="" width="120" height="61">` in the existing `a.brand` with its `aria-label` | 120 x 61 px |
| Admin login, staff sign-in | B1 light | 120 x 61 px |
| Admin sidebar | N1, `mark-n1-dark.svg` | 48 px |
| Photo placeholder (`Photo` in `ui.jsx`) | `mark-n1.svg`, centred | `min(40%, 96px)` wide; a container query under 120 px switches to `mark-n1-small.svg` |

- **Photo placeholder.** It keeps `aria-label="Фото ще не додано"` and drops the "LOREM STORE" text.
- **`index.html`.**
  - `<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">`;
  - `<link rel="icon" href="/brand/favicon-32.png" type="image/png" sizes="32x32">` and the 16 px equivalent;
  - `<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">`;
  - `<link rel="manifest" href="/brand/site.webmanifest">`;
  - `theme-color` `#1b201d` (today `#090909`);
  - `og:title`, `og:description` and `og:image` `https://example.com/brand/og.png`. The URL must be absolute and the shell is static, so staging shares point at production's image, which is accepted.
- **Worker product page.** It gets the same icon, apple-touch-icon and manifest links. Its `og:image` stays the product photo.
- **The brand task's notes.** They already state these minimums, so no alignment is needed after L-6.

## Decision 6: build tasks

### Scaffold task: T8 "wave-3 scaffold"

It branches from the wave-2 integration. It is merged before T3, T5 and T6 branch from it. It owns only these edits:

- **Stub files.** Creates `apps/web/src/cart/cart-moment.css` and `apps/web/src/landing/brand.css`, each empty with an owner comment. New CSS files are scanned by the token check at once; empty files pass.
- **CSS imports.** Imports both files in `main.jsx`, after `streetwear.css`.
- **Brand props.** Gives `Brand` in `ui.jsx` the new `variant` and `on` props, still rendering today's wordmark. The `brand-light` class is kept when `variant === 'mark'`, so the sidebar looks as it does today. It switches these call sites:
  - `main.jsx` admin sidebar → `<Brand variant="mark"/>`;
  - `main.jsx` logins and `StaffSignIn.jsx` → `<Brand on="light"/>`.
- **Placeholder tests.** Registers placeholder tests `tests/frontend/{fresh-drop,cart-moment,brand}.test.js` in the `package.json` `test` script.

### Ownership order

- `ui.jsx` changes first in the scaffold, then only in T6.
- `main.jsx` and `package.json` change first in the scaffold, then only in T3.
- After the scaffold, the owned paths below do not overlap.

### Tasks

| Bead | Owns (exclusive after the scaffold) | Depends on | Acceptance |
| --- | --- | --- | --- |
| **T3** hero H4 + retire intro | `apps/web/src/Storefront.jsx`, `apps/web/src/main.jsx`, new `apps/web/src/navigation.js`, new `apps/web/src/products-feed.js`, new `apps/web/src/landing/FreshDrop.jsx`, new `apps/web/src/landing/fresh-drop.js`, `apps/web/src/landing/hero.css`, `apps/web/src/FeaturedRail.jsx` and `apps/web/src/featured-rail.css` (image priority and deferral only), `apps/web/src/catalog-filters.js`, `package.json`, `package-lock.json`, every deletion in Decision 1 (including `hero-wall.webp`), `tests/frontend/page-ending.test.js`, `tests/frontend/fresh-drop.test.js`, new `tests/e2e/fresh-drop.spec.js`, the motion brief (since removed), `docs/ARCHITECTURE.md` (one landing line). For the intro-removal edits only: `tools/design-tokens-check.mjs`, `tests/backend/design-tokens.test.js`, `apps/web/src/tokens.css`, `docs/design/DESIGN.md` | T8 | See the T3 acceptance list below |
| ~~T4 wall band~~ | — | — | Won't do (L-1) |
| **T5** cart moment | `apps/web/src/cart/cart-store.js`, `apps/web/src/cart/CartLink.jsx`, `apps/web/src/cart/QuickAdd.jsx`, `apps/web/src/cart/SizePicker.jsx`, `apps/web/src/cart/cart-moment.css`, `tests/frontend/cart-moment.test.js`, new `tests/e2e/cart-moment.spec.js` | T8 | See the T5 acceptance list below |
| **T6** logo swap + favicon/manifest/og | `apps/web/src/ui.jsx` (Brand and Photo bodies), `apps/web/src/landing/SiteHeader.jsx` (`HeaderLogo` and its `variant` from `Bar`), `apps/web/src/landing/brand.css`, `apps/web/index.html`, `apps/web/public/brand/site.webmanifest` (the `display` line only), `apps/api/src/product-page.js`, `tests/backend/product-page.test.js`, `tests/e2e/product-page.spec.js`, `tests/frontend/brand.test.js`, new `tests/e2e/brand.spec.js`; uses the other `apps/web/public/brand/*` files as delivered | T8; T2 merged | See the T6 acceptance list below |

**T3 acceptance.**

- A grep over `apps/`, `tests/`, `tools/`, `package.json` and `package-lock.json` finds:
  - no `from 'three'` or `from "three"` import;
  - no `"three":` dependency key;
  - no `spray-`, `SprayIntro`, `data-spray`, `__ssSprayIntroTest` or `hero-wall`.
- The stale `?intro=0` in `tests/e2e/campaign.spec.js` is harmless and stays.
- The token check and its test pass, with no `spray-intro.css` and no `--z-intro`.
- The hero index line is gone.
- Unit tests for `pickFreshDrop`:
  - sold-out, photo-less and zero-price items are excluded;
  - ties break by slug;
  - with three or more categories, one item per category, with `unclassified`/null as one category;
  - with two categories the result is a1, b1, a2;
  - with one category it is the three newest.
- Unit tests for `loadProducts`: one request, the memo is cleared on rejection, no unhandled rejection.
- e2e at 1440, 820 and 390:
  - the three tiles link to the right slugs;
  - the lead image has `fetchpriority=high`;
  - the tile images have `alt=""`;
  - there is zero `layout-shift` from skeleton to content and from skeleton to the copy-only fallback (API error, route mocked);
  - `/api/products` starts before `/api/taxonomy` resolves;
  - rail images are `fetchpriority=low` and are not requested before the lead image settles;
  - the sticky bar still pins.
- The LCP gate passes, or is reported to the lead as a decision.
- `npm test`, `npm run check` and `npm run build` pass, and the main entry gzip does not grow.

**T5 acceptance.**

- Unit: `subscribeAdded` fires once per successful add, and never on refresh, quantity change, remove or checkout.
- Unit: `CartLink` plays for added and merged, not for capped or stock_capped.
- e2e:
  - a QuickAdd add shows `.cart-moment` under the visible bag, together with the live-region text;
  - `/cart?add=` from the product page plays it once;
  - reduced motion shows no transform animation;
  - zero `layout-shift`.
- The existing cart unit and e2e tests are unchanged and green.
- The CSS uses tokens only.

**T6 acceptance.**

- The header shows B1 at 120 x 61 px and the bar shows S1 at 64 x 35 px, at 1440, 820 and 390.
- The footer B1 is at least 120 px wide.
- The product page shows B1 at 120 x 61 px and keeps its `aria-label`.
- Logins show B1 light.
- The admin sidebar uses `mark-n1-dark.svg`.
- The photo placeholder uses `mark-n1.svg` and keeps its `aria-label`.
- Both shells (the SPA and the Worker product page) carry the favicon SVG and PNGs, the apple-touch-icon, the manifest and `theme-color`.
- The manifest has `display: browser`.
- Every referenced `/brand/*` file returns 200 in the build.
- No logo `layout-shift`.
- The CSS uses tokens only.

### Merge order

1. T8, the scaffold.
2. T3 and T5, in either order. Their paths are disjoint, so they can run in parallel.
3. T6, after T2.

Every PR goes to `staging` first, per WORKFLOW.md. `tests/e2e/header.spec.js` (wave 2) also asserts header markup. If it asserts the wordmark text, T6 reports that to the orchestrator; it does not edit that spec.

## Consequences

- **First screen.** It shows stock instead of a 247 kB photo. The lead tile is a thumbnail of tens of kB once production thumbnails exist (see the runbook).
- **No wall photo.** The wall photo leaves the site. The graffiti atmosphere now lives only in the rack room and the editorial poster.
- **LCP.** The hero image waits for one more API round trip, offset by the early request. Rack images have to yield to the hero (LCP gate).
- **The spray.** It survives only as a 0.4 s rule under the bag, which every buyer sees, for about 1 kB of CSS.
- **Cruft.** `withPreserved` remains as a pass-through, and dead hero CSS remains in `streetwear.css`.
- **"Newest".** It becomes honest only after the `listed_at` follow-up; until then it reflects the latest sync. The distinct-category pass keeps the trio varied.

## Revisit triggers

- **LCP.** Field or lab LCP on the landing at p75 above 2.5 s on phones, with thumbnails present. Then reconsider option A (a Worker-inlined trio plus an image preload), or caching `/api/products`.
- **Catalog size.** ADR-0013 paged mode lands, or the catalog grows past about 1,000 items, so the landing no longer downloads the full list.
- **Thumbnails.** Thumbnails lag behind new stock in practice. Then generate the card derivative at sync time, or add a larger hero derivative.
- **`listed_at`.** The follow-up lands: switch the sort key.
- **Spray visibility.** The lead wants the spray more visible: loader option (a) from logo round 3.

## Lead answers

1. **L-1, page order.** The wall band is dropped. The final order is: hero, ticker, rack room, campaign band, catalog, editorial, delivery, footer. `hero-wall.webp` leaves the page, and the hero fallback is copy only. T4 is won't-do.
2. **L-2, the hero pick.** One per category among the newest, confirmed. With two categories, pass 2 fills (a1, b1, a2). Strictly newest only applies with one category.
3. **L-3, repetition.** Accepted: the trio overlaps the head of the grid.
4. **L-4, the cart line.** It fades by 2.4 s.
5. **L-5, capped adds.** They play no moment.
6. **L-6, logo sizes.** T2's minimums: B1 at least 120 px wide (61 px high) in the header, the footer and the Worker product page; S1 64 px wide (35 px high) in the sticky bar.
7. **L-7, manifest display.** `browser`.
8. **L-8, wall band loading.** Moot, because the band is dropped.
9. **Open: the LCP gate.** If T3's mitigation does not bring LCP within 300 ms of the base, the trade-off comes back to the lead.
10. **Pending: production thumbnails.** Running the [go-live runbook](../MEDIA.md#card-thumbnails) against production needs separate lead approval (lead question Q14).
