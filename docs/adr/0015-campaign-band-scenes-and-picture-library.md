# ADR-0015: Campaign band scenes and a staff-managed category picture library

Status: **Proposed**. Lead decisions L1–L6 below are open.

Number: 0010 and 0013 were claimed by branches that never merged; 0014 is the fresh-drop hero. Migration 0022 is the checkout-recipient migration (`0022_checkout_recipient_prepayment.sql`), so this design uses 0023. The orchestrator confirms both numbers before the child tasks start.

The design mockups, the render script and the occlusion measurements were working files and are not kept in this repository.

## Context

**Lead request.** Keep the campaign band: the category label, the in-stock count, the brands and the from-price, built from category cut-outs. Change only the scene.

- Today the third cut-out (the side view) is covered by the front one, so only its hanger shows.
- Add a set of scenes the admin chooses from in **Вітрина**, with a preview.
- Each item in a scene is a separate picture. Staff can keep several pictures per category and change them in the admin.
- The lead has already rejected a new generic multi-brand promo photo.

**Code facts at the staging base revision.**

- **Band.** `apps/web/src/landing/CampaignBand.jsx` renders `.campaign-wall`, `.campaign-copy` and `.campaign-art` with three `<img>` from `campaign.images`.
  - `pickCampaign()` in `campaign.js` builds `images` as `[angle || side, front, side || angle]` from `rail-media.json` `clothes`.
  - `rail-media.json` has 12 categories, each with `front`, `side` and `angle` cut-outs. All of them include a hanger.
- **Admin.** `StorefrontSettings.jsx` holds campaign mode, category and excluded categories, plus the ticker.
  - The category options and the eligible set both come from `RAIL.clothes`.
  - Saving needs `settings.manage`, which is owner-only. Managers see the tab read-only.
- **API.** `storefront_settings` (migration 0020) is a key → JSON table with the keys `campaign` and `ticker`.
  - `validateCampaign` rejects unknown fields, and `PUT /api/admin/storefront/campaign` replaces the whole object.
  - `GET /api/storefront` is public. `tests/backend/storefront-settings.test.js` pins the exact normalized objects and that managers lack `settings.manage`.
- **Media.**
  - `POST /api/admin/media` (`media.upload`) accepts JPEG, PNG or WebP up to 5 MB, sniffed by magic bytes, and stores `<uuid>.<ext>` in R2 `MEDIA`. It records no dimensions or alpha.
  - `GET /media/*` returns 404 to anonymous callers unless a published product uses the URL. It runs `publicCatalog` for each request and sends `no-store`.
  - `photoUrl()` accepts only `/media/[a-f0-9-]+.(jpg|png|webp)`.
- **Background removal.** It runs in the browser: `processImage(blob)` in `background-removal.js`, with `isDegenerateMask` in `cutout-photo.js`.
  - `prepareCutout()` is tied to a product, because it fetches through `/api/admin/products/:id/image`.
- **Styles.** One SPA bundle imports every stylesheet in `main.jsx`, so `.storefront`-scoped band CSS is already loaded in the admin.
  - `campaign.css` is on the design-token `LEGACY_ALLOWLIST`. A new storefront CSS file must use tokens only.

### Diagnosis: why the side view disappears

`campaign.css` places the three images like this:

```css
.storefront .campaign-art img{position:absolute;bottom:-6%;width:auto;max-width:none}
.storefront .campaign-art img:nth-child(1){height:86%;left:2%}
.storefront .campaign-art img:nth-child(2){height:104%;left:29%;z-index:2}
.storefront .campaign-art img:nth-child(3){height:88%;left:62%}
```

The **left** offset is a percentage of the art box **width**. The **size** is a percentage of the art box **height**, and the width follows from each picture's own aspect ratio.

At 1440 the art box is 756×496. The front image is 516 px high, so the front cut-outs are 342–432 px wide (234–240 px for the narrow jeans and pants fronts). Starting at `left:29%` (219 px), the front covers 29% to 75–86% of the art width.

The side view starts at `left:62%` and is only 46–131 px wide, because side cut-outs are narrow (aspect 0.11–0.30). For most categories it therefore lands entirely inside the front's horizontal span, beneath it (`z-index:2`).

The front cut-out's top 10–13% is transparent apart from its own hook. The side view's hanger sits 80 px lower than the front's and pokes out into that transparent area. That is the stray hanger.

The positions were tuned to one assumed front width. Nothing constrains a picture to its place, so any wider front swallows its neighbour. A second defect: when a category lacks `angle`, the list contains `side` twice, and both images get the same React key.

Measured pixel occlusion with the real `campaign.css` and all 12 rail categories: the share of the third image's opaque pixels painted over by the front. A render script reproduced the measurement.

| Category | 1440 | 390 |
| --- | --- | --- |
| puffer-jackets, sweatshirts, tshirts-polos, shorts | 99–100% | 99–100% |
| cardigans, turtlenecks, coats-vests | 90–96% | 95–99% |
| windbreakers, zip-hoodies, hoodies | 77–87% | 84–90% |
| jeans, pants-other (narrow fronts) | 0% | 6% |

The before shots are `before-1440.webp` and `before-390.webp`.

## Decision 1: scenes are code-defined presets

### Options

| Option | For | Against | Outcome |
| --- | --- | --- | --- |
| **A. Code presets** in `packages/catalog/campaign-scenes.js`; the admin picks one by id | Geometry is reviewed and tested in CI, including the no-hide rule. Backgrounds are static assets that need a PR anyway. No geometry editor to build or secure. Follows the ADR-0008 template precedent. | New scenes need a PR | **Chosen** |
| B. Scenes stored in D1 and editable (slot boxes as numbers) | Staff can tweak without a deploy | Needs a geometry editor. The no-hide rule moves to server validation, and bad layouts reach production. Backgrounds would also need upload and serving rules. | Rejected |
| C. Free drag-and-drop placement per category | Maximum freedom | Biggest UI. The layout must be authored for two breakpoints. It is the most likely to recreate the overlap bug. | Rejected |

### Scene model

A pure module, `packages/catalog/campaign-scenes.js`, is imported by both the Worker (to validate `sceneId`) and the web app. The prototype scene data was a design working file.

```js
// All boxes are percentages of the band's art box (.campaign-art), never of the viewport or of the band.
Scene = {
  id: 'fan' | 'rail' | 'hooks' | 'floor',   // stable; renamed ids go through SCENE_ALIASES
  label: 'Віяло',                            // admin label (uk)
  anchor: 'top' | 'bottom' | 'center',       // hangs from the box top, stands on its bottom, or lies flat
  background: { src, srcSet, width, height, position: { desktop: 'right center', mobile: '72% center' } },
  props: [{ kind: 'rail', desktop: { x, y, w }, mobile: { x, y, w } } | { kind: 'hooks' }],
  layouts: {                                 // keyed by picture count; the band uses the largest key <= pictures
    3: { desktop: [Slot, Slot, Slot], mobile: [Slot, Slot, Slot] },
    2: { ... }, 1: { ... },                  // 1 and 2 are required, so any category with one picture renders
  },
  available: true,                           // false until its background art is merged (floor)
}
Slot = { x, y, w, h, z, r }                  // top-left, size, paint order, rotation in degrees
export const DEFAULT_SCENE_ID = 'fan';
export const SCENES, SCENE_IDS, getScene(id), sceneLayout(scene, count), sceneViolations(scene);
```

- **Slot order is rank.** Picture 1 of a category fills slot 1, which is the hero.
- **The fix.** A slot is a box, and its picture is drawn with `object-fit: contain`, using `object-position` from the anchor. A picture's aspect ratio can never move or widen its box, which removes the cause above.
- **Bounds.**
  - Horizontally, `0 <= x` and `x + w <= 100`.
  - `y >= 0`, and the bottom may extend to `y + h <= 112`. The band clips that overflow, as today's hero does.
  - Rotation is limited to `|r| <= 18`.
- **Props.**
  - Props are scene furniture: the rail bar and the wall hooks. They are drawn by CSS in the same art-box coordinates, so they line up with the slots at every width.
  - Backgrounds are texture only, and props are never part of the background image. `.campaign-wall` covers the whole band with `object-fit: cover`, which crops differently at 1440 and 390, so baked-in props would drift away from the slots.
- **Rendering.**
  - Each slot is a `div.scene-slot` with inline custom properties `--x --y --w --h --z --r` (desktop) and `--mx … --mr` (mobile).
  - A new `apps/web/src/landing/campaign-scenes.css`, which uses tokens only, maps them to `left`, `top`, `width`, `height`, `z-index` and `transform`.
  - Desktop slots that have no mobile counterpart get `data-mobile="off"`.
  - The old `.campaign-art img` and `:nth-child` rules are deleted.

### No slot may hide another

The rule has two levels, and both must pass.

1. **Static rule (CI, independent of picture shape).**
   - Each slot has a protected core: the centred third of its width, over the 70% of its height nearest its anchor.
   - No slot painted above it (higher `z`, or equal `z` and later in the list) may intersect that core with its rotated bounding box.
   - This is checked for every scene, every layout and both modes, at the reference art sizes 756×496, 580×496 and 390×270.
   - `sceneViolations()` returns a list of problems, and a unit test asserts that the list is empty.
   - The core is a centred third because narrow side views (aspect 0.11–0.30) are drawn in the centre of their box by `contain`. They fall inside the core.
2. **Pixel rule (QA, real pictures).**
   - Render every available scene with every rail category at 1440 and 390, using the render script's method.
   - **Each picture must keep at least 80% of its opaque pixels visible.**
   - For the proposed data, the minimum is 86% (fan and floor; the rail and hooks scenes show 100% of every picture). Today the minimum is 0%.
   - A stress pass uses fully opaque rectangles of 4:3, 1:1 and 1:3, plus a slot-filling case in which each picture has exactly its slot box's aspect ratio. That last case is the worst for library pictures. Every case must keep at least 65% visible. The proposed minimum is reported in the mockup README.

### Responsive rules and container queries

- **Container queries.**
  - The band gets a wrapper `div.campaign-frame { container: campaign / inline-size }`.
  - In `campaign.css`, `@media (max-width:650px)` and `(min-width:1100px)` become `@container campaign (...)`, and `vw` becomes `cqi`.
  - A 390 px preview frame inside the 1440 px admin page then renders the real mobile band. A media query cannot do that, and an iframe would need a separate preview route and `postMessage` for unsaved state.
  - Browser support is Chrome/Edge 105+, Safari 16+ and Firefox 110+. `admin-preview-1440.webp` proves it with the converted stylesheet.
  - **Fallback for older browsers.** The storefront keeps the existing `@media (max-width:650px)` and `(min-width:1100px)` blocks next to the `@container` blocks, with the same declarations, including the mobile slot variables. A real phone gets the mobile band either way. Only the admin preview needs container queries.
- **Desktop (art box about 756×496 at 1440, 580×496 at 1100).** Use the desktop slots. The copy column and the band height are unchanged.
- **Mobile (art strip 390×270).** Use the mobile slots.
  - At most three pictures are shown; the fourth hooks slot is desktop-only.
  - Fewer pictures are not shrunk into overlap: each scene's mobile layout is non-overlapping or overlaps only outside the cores.
- **Background.** Its focal point is per breakpoint, via `object-position`, as today (`right center` and `72% center`).

## Decision 2: the proposed scenes

| Id | Label | Anchor | Layout | Background | Min visible (1440 / 390) |
| --- | --- | --- | --- | --- | --- |
| `fan` (**default**) | Віяло | bottom | The hero is centred and large, running past the bottom edge as today. The two outer pieces are tilted −8°/+8° and sit partly behind it, never at their centres | Existing `campaign-wall.webp` (lime circle) | 87% / 92% |
| `rail` | Рейл | top | Three hangers spaced along a CSS steel rail at 8% from the top, with no overlap. The hero hangs longer (96% versus 84%) | Existing wall works; optional `campaign-wall-plain.webp` | 100% / 100% |
| `hooks` | Гачки | top | Each piece hangs on its own wall peg at a staggered height. A fourth picture is allowed on desktop only | Existing wall; optional plain wall | 100% / 100% |
| `floor` | Флет-лей | center | Pieces lie flat on a floor seen from above, turned −14°, +4° and +16° | **New art required**; until then the scene is `available:false` | 86% / 87% |

- `fan` is the default because it is today's composition with the defect fixed. A row with no `sceneId` keeps the familiar look.
- `floor` with the rail cut-outs shows hangers lying flat, which looks staged. It suits hanger-free pictures from the library (L4).

### Background prompts (for Codex generation)

All backgrounds are empty: no garments, hangers, rails, hooks, text, logos or people.

- 1600×900 WebP plus an 800 px version, matching the existing `campaign-wall` and `campaign-wall-800` pair.
- The left 40% should be plain and dark, because the copy and the moss gradient sit there.
- The product area is the right 55%.

1. **`campaign-floor.webp`, required for `floor`.**
   > Orthographic top-down photo of a smooth painted concrete floor in deep moss green (around #33412f to #4a5a44), soft even overhead light, subtle trowel texture, a few faint scuffs and a thin sprayed lime (#d7f16c) line crossing the lower right corner. No perspective, no vignette, no objects, shadows or text. The left 40% is darker and plain. 16:9, 1600×900, photographic, matte.
2. **`campaign-wall-plain.webp`, optional for `rail` and `hooks`.**
   > Frontal photo of the same moss-green painted plaster wall as the current campaign wall: soft light from the top left, a few torn paper poster scraps and tape only at the far right edge, faint lime spray drips at the top right. The centre-right area is empty and evenly lit for hanging products. No circle, rail, hooks, objects or text. 16:9, 1600×900.
3. **`campaign-pegboard.webp`, optional alternative for `hooks`.**
   > Frontal photo of a moss-green painted wooden pegboard wall with a regular grid of small round holes, soft top light, slightly worn paint. No pegs, hooks, objects or text. The left 40% is darker. 16:9, 1600×900.

Each new background needs a provenance entry under `apps/web/public/licenses/`, as `campaign-wall.webp` has.

## Decision 3: a staff-managed picture library per category

### Storage: new table, not settings JSON

| Option | For | Against | Outcome |
| --- | --- | --- | --- |
| A. A `campaign_pictures` key in `storefront_settings` JSON | No migration | The public `/media` rule would parse the whole document on every image request. Two staff editing different categories clobber each other's whole document. No uniqueness on the R2 key. | Rejected |
| **B. New table `campaign_pictures` (migration 0023)** | An indexed lookup for the public `/media` rule. Per-row writes and per-category ordering. Rows are staff data, separate from supplier snapshots and product overlays. | One migration | **Chosen** |

```sql
-- migrations/0023_campaign_pictures.sql
CREATE TABLE campaign_pictures(
  id TEXT PRIMARY KEY,                         -- uuid
  category_id TEXT NOT NULL,                   -- taxonomy id as chosen; resolved through aliases on read
  media_key TEXT NOT NULL UNIQUE,              -- 'campaign/<uuid>.webp' or '.png' in R2 MEDIA
  width INTEGER NOT NULL CHECK(width BETWEEN 64 AND 1600),
  height INTEGER NOT NULL CHECK(height BETWEEN 64 AND 1600),
  position INTEGER NOT NULL,                   -- 0-based order inside the category
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX campaign_pictures_category ON campaign_pictures(category_id, position);
```

The scene choice is **not** in this table. It goes into the existing `campaign` JSON (Decision 4).

### Upload pipeline

The picture is uploaded to R2 `MEDIA` and served through `/media/`, as product photos are. It uses its own endpoint, because the generic `/api/admin/media`:

- accepts JPEG (no alpha);
- allows 5 MB;
- records no size;
- writes keys that `photoUrl()` accepts as product photos.

Browser steps, in a new module `apps/web/src/campaign-pictures.js` that is pure where possible and unit-tested:

1. Staff choose a category and one or more files: JPEG, PNG or WebP, up to 20 MB each before processing.
2. **«Прибрати фон», on by default.** Run `processImage(blob)` from `background-removal.js` directly; it is not tied to a product. Reject the result with `DEGENERATE_MESSAGE` when `isDegenerateMask` is true. With the option off, the file must already contain transparency, meaning at least 1% transparent pixels.
3. **Trim** to the alpha bounding box with 2% padding, so that a picture's transparent margins do not shrink it inside its slot. The rail cut-outs appear tightly cropped, but this has not been verified pixel by pixel; the frontend task checks it.
4. **Downscale** so the long side is at most 1200 px. Encode WebP with alpha at quality 0.9. If the browser cannot encode WebP, use PNG. If the result exceeds 2 MB, retry at a long side of 900 px.
5. **Preview** on a checkerboard and in the live band preview. The picture is uploaded only on «Зберегти картинку»; «Скасувати» discards it.

Server checks (`POST /api/admin/storefront/pictures`):

- `MEDIA` must be bound (otherwise 503), the body must be multipart (otherwise 415) and it is read with `readBounded` at 2.2 MB.
- The file must be at most 2,000,000 bytes (otherwise 413).
- Magic bytes must be PNG or WebP (otherwise 415).
- Dimensions are read from the header (PNG IHDR; WebP VP8X, VP8L or VP8), never trusted from the client, and must be 64–1600 on each side (otherwise 400).
- The header must declare alpha (PNG colour type 4 or 6, or a `tRNS` chunk; WebP VP8X alpha flag or VP8L), otherwise 415 «Потрібна картинка з прозорим фоном».
- `categoryId` must resolve in the current taxonomy (otherwise 400).
- There may be at most **12 pictures per category** and **300 in total** (otherwise 409).
- The key is `campaign/<uuid>.<ext>`. `position` is the category's current maximum + 1.
- The file is put in R2 first. If the D1 insert then fails, the object is deleted; a delete failure leaves a private orphan, because without a row the object is never public.

### Fill order and fallback

- **Pictures for a category** are its library pictures in `position` order, followed by that category's `rail-media.json` cut-outs in the order **front, angle, side** (L3, mix).
  - The list is de-duplicated by `src`, and the band takes as many pictures as the scene's largest layout.
  - So the first upload to a category replaces only the hero. The band never drops to a smaller layout because staff have started a library.
  - Under the L3 alternative ("library only once it has a picture"), one upload would drop the live band to the 1-picture layout until more arrive. That is why mixing is the default.
  - It is a one-line switch in `campaignArt()`.
- **Layout.** De-duplication also fixes the duplicate React key. The band uses `sceneLayout(scene, n)` and fills the slots in rank order.
- **Library categories.** Only leaf categories (categories with no children in the current taxonomy) can hold pictures. The server enforces this with the same rule as the admin select. A parent category such as `outerwear` therefore cannot start headlining because someone uploaded to it. If a leaf later gains children (ARCHITECTURE.md allows this), its existing pictures stay and are still used; only new uploads to it are refused.
- **Eligible categories** for the band and for the admin category list are the categories with at least one picture, from the library or from the rail fallback.
  - Consequence: the first picture uploaded to a new leaf category makes that category eligible for the automatic pick at once, because picture actions save immediately.
  - It wins only if it has the most in-stock items.
  - The admin panel shows the resulting «Зараз на головній» after every picture action, and staff can exclude the category. `pickCampaign(products, taxonomy, art, settings)` keeps its signature. `art` becomes `[{ categoryId, pictures: [{src,w,h}] }]`, built by a new `campaignArt(rail, libraryPictures)`, and `campaign.images` becomes those pictures.
- **Retired or redirected categories.**
  - On read, `category_id` is resolved with the taxonomy's `resolveCategoryId`, and pictures are grouped under the resolved id.
  - Rows whose category no longer exists are left out of the public projection. Their files stay publicly readable under the serving rule below: they are decorative staff art, not private data. The admin lists them under «Видалена категорія» with a delete button.
  - Rows are never rewritten automatically.

### Public serving rule

- `serveMedia` accepts `campaign/<uuid>.(png|webp)` keys as well.
- For an anonymous caller, the key is public **if and only if** a `campaign_pictures` row has that `media_key`: one indexed `SELECT 1`, no `publicCatalog` scan. A missing table or a failed lookup returns 404.
- Access or `media.read` callers can read the key as before.
- Public responses send `Cache-Control: public, max-age=3600` (L5), because the keys are random and never overwritten. Other media keep `no-store`.
- A deleted picture can survive up to an hour in browser caches. It is decorative staff art with no private data.
- `photoUrl()` still rejects `/media/campaign/...` because of the slash, so a campaign picture cannot become a product photo. A test asserts this.

## Decision 4: storing the scene choice and the API

### Scene id in the existing campaign JSON

- The campaign object becomes `{mode, categoryId, excluded, sceneId}`.
- `normalizeCampaign` maps a missing or unknown `sceneId` (after `SCENE_ALIASES`) to `DEFAULT_SCENE_ID`. It also maps a scene with `available:false` to the default.
- `validateCampaign` accepts an optional `sceneId`, which must be in `SCENE_IDS` and available.
  - It includes the `sceneId` key in its result **only when the body has one**.
  - Bodies without `sceneId` therefore validate to exactly today's objects, and the existing strict `deepEqual` cases stay unchanged.
- **No clobbering.**
  - The handler stores `{...validated, sceneId: validated.sceneId ?? stored.sceneId ?? DEFAULT_SCENE_ID}`, read and written in the same handler.
  - An admin tab opened before this change therefore cannot reset the scene.
  - `normalizeCampaign` always returns `sceneId`.
- No migration is needed for this; the existing row simply has no `sceneId`.
- In `tests/backend/storefront-settings.test.js`, the `normalizeCampaign` expectations gain `sceneId: 'fan'`. New cases cover an explicit `sceneId`, an unknown or unavailable one, and the omit-keeps-stored merge.

### Endpoints

All admin routes are in `ADMIN_ROUTES`. They are protected by the existing principal resolution (Access or the staff cookie, never the customer cookie) and by the same-origin mutation check, and they are audited.

| Route id | Method and path | Permission | Request → response |
| --- | --- | --- | --- |
| `storefront.get` (existing) | `GET /api/admin/storefront` | `catalog.read` | Adds `campaign.sceneId` and `pictures: [{id, categoryId, src, w, h, position, createdAt, actor}]` |
| `storefront.campaign` (existing) | `PUT /api/admin/storefront/campaign` | `settings.manage` | Accepts optional `sceneId`; response as today, plus `sceneId` |
| `storefront.pictures.add` | `POST /api/admin/storefront/pictures` | `settings.manage` (L1) | multipart `file`, `categoryId` → 201 `{picture}` |
| `storefront.pictures.order` | `PUT /api/admin/storefront/pictures/order` | `settings.manage` (L1) | `{categoryId, ids:[...]}`; `ids` must be exactly that category's set → `{pictures:[...category]}` |
| `storefront.pictures.remove` | `DELETE /api/admin/storefront/pictures/:id` | `settings.manage` (L1) | → `{deleted: id}`. Deletes the row in D1, then the R2 object, then renumbers the category's positions |

Audit actions are `storefront.picture.add` `{id, categoryId, src, w, h}`, `storefront.picture.order` `{categoryId, ids}` and `storefront.picture.remove` `{id, categoryId, src}`. `storefront.campaign` details now include `sceneId`.

**Public projection.** `GET /api/storefront` returns:

```json
{"campaign":{"mode":"auto","categoryId":null,"excluded":["shorts"],"sceneId":"fan"},
 "ticker":{...},
 "campaignPictures":{"puffer-jackets":[{"src":"/media/campaign/<uuid>.webp","w":620,"h":900}]}}
```

- Only `src`, `w` and `h` are exposed: no ids, actors, timestamps or positions. The order is the array order.
- At most 12 pictures per category, keyed by resolved category id; categories that no longer exist are omitted.
- A missing table (code deployed before the migration) returns `{}`, just as `readKey` falls back today.

## Decision 5: storefront and admin UI

- **Band component.**
  - `CampaignBand.jsx` splits into `CampaignBand`, which loads settings and products and runs `pickCampaign`, and a pure `CampaignBandView({campaign, scene, pictures, preview})`.
  - The storefront and the admin preview render the same `CampaignBandView`.
  - The view renders `div.campaign-frame > section.campaign-band[data-scene]`, with the background, the props and the slots.
  - Images keep `alt=""`, `loading="lazy"`, `decoding="async"` and explicit `width`/`height`.
  - The loading shell keeps its height.
- **The Вітрина tab, section «Промо на головній».**
  - **Scene.** Radio cards for the available scenes, with unavailable ones shown disabled («потрібен фон»).
  - **Live preview.** Two frames of the real `CampaignBandView`.
    - «Комп'ютер · 1440»: a 1440 px frame scaled to the panel width with `transform: scale`, measured by a `ResizeObserver`. Container queries see 1440.
    - «Телефон · 390»: a 390 px frame.
    - The preview uses the unsaved form: mode, category, excluded and scene. «Показати категорію» lets staff preview any eligible category without saving it.
  - **«Картинки категорії».**
    - A category select lists the taxonomy leaf categories with picture counts.
    - A grid on a checkerboard shows the pictures, with ↑/↓ order buttons like the ticker, «Видалити» with `ConfirmDialog`, and «+ Додати» (multiple files, the remove-background toggle, `cutoutProgressLabel` progress, preview, then save or cancel).
    - When the library is empty, the rail fallbacks are shown greyed as «стандартна». They cannot be edited.
  - **Saving.** Picture actions save immediately (each is one API call). Scene and mode save with «Зберегти», as today. The panel says so.
  - Non-owners see everything read-only; the existing notice covers this.

## Delivery plan

Each step delivers a PR to `staging`. Shared files have one owner per step, and the integration order is the table order.

| Step | Role | Owns | Depends on |
| --- | --- | --- | --- |
| 1 | frontend/backend | `packages/catalog/campaign-scenes.js`, `tests/frontend/campaign-scenes.test.js`, `package.json` (first) | — |
| 2 | backend | `migrations/0023_campaign_pictures.sql`, `apps/api/src/campaign-pictures.js`, `storefront-settings.js`, `index.js`, `permissions.js`, backend tests, `package.json` (second), `docs/API.md` | 1 |
| 3 | frontend | `landing/CampaignBand.jsx`, `campaign.js`, `campaign.css`, `campaign-scenes.css`, `main.jsx` (one import), `tests/frontend/campaign.test.js`, `tests/e2e/campaign.spec.js` | 1, 2 contract |
| 4 | frontend | `StorefrontSettings.jsx`, `campaign-pictures.js`, `styles.css` (new section), its unit test, `package.json` (third) | 2, 3 |
| 5 | qa | `tests/e2e/campaign-scenes.spec.js` | 3, 4 |
| 6 | frontend | floor background, licence entry, `floor` `available:true` | 1, lead art |

## Consequences

- The overlap bug is removed by construction: boxes plus `contain`, the static rule in CI, and the pixel rule in QA.
- Staff can change the band's pictures without a deploy. Picture actions are live at once, while the scene and mode wait for «Зберегти». New scene geometry or backgrounds still need a PR.
- There is one new table, one public `/media` rule (an indexed lookup), three admin routes and one new public field.
- Campaign pictures are staff data, separate from supplier snapshots and product overlays; product sync never touches them.
- The band markup gains a wrapper, so the e2e checks that use `band.nextElementSibling` and count exactly 3 images change.
- `campaign.css` stays on the legacy allowlist. It loses its image rules and switches to container queries; the new scene CSS uses tokens only.
- The first background-removal run downloads the 88 MB FP16 model in the browser, as in the product editor (MEDIA.md).

## Lead decisions

| # | Decision | Default in this design |
| --- | --- | --- |
| L1 | Who manages pictures: owners only (`settings.manage`) or managers too (`media.upload`) | Owners only, consistent with the rest of Вітрина |
| L2 | Which scenes to build first, and the default scene | Build `fan` (default), `rail` and `hooks` now; `floor` after its background |
| L3 | Does a category's library mix with the rail cut-outs (library first, then fallbacks) or replace them once it has a picture | Mix, because replacing drops the live band to a 1-picture layout on the first upload |
| L4 | `floor`: build it with hanger-free pictures, or drop it | Build after the art, and the admin warns that it suits hanger-free pictures |
| L5 | Cache for public campaign pictures | `public, max-age=3600` |
| L6 | New art: a plain wall without the lime circle for `rail` and `hooks`, or keep the current wall | Keep the current wall; plain wall optional |

## Revisit triggers

- Staff need geometry tweaks more than about once a month, or more than six scenes exist: consider D1-stored scene data (option B) with server-side `sceneViolations`.
- A category regularly has more than three good pictures: add a daily rotation through the library (deterministic by date) instead of always using the first N.
- Card thumbnails gain a server-side image pipeline: move trim and downscale server-side.
- Container-query support becomes a problem in the analytics browser mix: fall back to an iframe preview.
- ADR-0013 paged catalog mode: `pickCampaign` would need category counts from the API instead of the full list.
