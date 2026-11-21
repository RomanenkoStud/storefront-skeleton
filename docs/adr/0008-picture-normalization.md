# ADR-0008: Product picture normalization to category templates

Status: **Accepted**. The lead accepted the decisions recorded in [Decisions](#decisions). **Pending:** the in-browser fitter model is chosen by a separate model spike, which amends this record on its own branch. This record authorizes no paid API, no server-side AI, no new service and no bulk change to real inventory. Its only new download is the one in-browser fitter model that the model spike selects, under the same on-demand, version-pinned caching rules as the background-removal model. The full contract, template schema, fit-module interface, spike measurements and task breakdown are in [MEDIA.md](../MEDIA.md#picture-normalization-fit).

## Context

- **The lead's request.** After background removal, product pictures are still inconsistent: rotation differs, items appear at different scales and some look wrinkled. The lead wants per-category templates that define pose, orientation, scale and placement. A fitting step should adjust the cutout to the template. The lead later clarified this as a neural network running in the manager's browser (decision D-a). The goal is a consistent catalog on which uniform styling can be applied.
- **The current cutout pipeline** ([MEDIA.md](../MEDIA.md#background-removal)) runs IS-Net FP16 in a browser module worker (`apps/web/src/background-removal.worker.js`) with WebGPU first and WASM fallback. It outputs a PNG with the original dimensions and RGB and a model-predicted alpha mask. It does no cropping, rotation or generative editing. The editor (`apps/web/src/ImageCutout.jsx`, mounted in the photos tab of `apps/web/src/main.jsx`) previews the result. On acceptance, `POST /api/admin/products/:id/cutout` (`saveCutout` in `apps/api/src/image-processing.js`, permission `media.upload`) re-fetches the original, verifies its SHA-256 against the preview's `originalHash` (409 on change) and stores two R2 objects: the archived original and the cutout. The cutout's R2 `customMetadata` holds `{productId, originalUrl, sourceUrl}`. The editor then writes the cutout URL into the existing photo override. Restoring the original writes the archived `originalUrl` back through the same override.
- **Ownership.** Supplier snapshots keep supplier photo URLs and are never rewritten. The manager overlay `photos` list owns the effective ordered photos. R2 objects are private until a published product's effective photo list references them (`serveMedia` in `apps/api/src/index.js`). Archival lineage lives only in R2 metadata and the private `image-originals` response.
- **Taxonomy.** Category IDs are stable and manager-editable in D1 `taxonomy_state` (migration 0007). Retired IDs redirect via `resolveCategoryId`, and every node has `ancestors`. The storefront card is a 3:4 box with `object-fit: cover` (`styles.css`, `streetwear.css`).
- **Spike measurement** (Node 22, synthetic masks, throwaway code, not committed). Minimum-area rectangle on the convex hull recovered the true angle exactly (±0.02°) for rectangle, shoe-like and T-shirt-like shapes at −12° to 88°. Principal-axis (PCA) angle was biased by about 4° on an asymmetric shoe shape. On a near-square T-shirt shape it was meaningless (eigenvalue ratio 0.97), giving an axis 90° off. Speckle noise plus a stray blob broke both estimators until connected-component filtering was added. Analysis took about 3 ms on a 1024² mask, and filtering plus analysis about 11 ms. A 4000×3000 mask took about 100 ms for component filtering and 30 ms for analysis.

## Options considered

### Fitting approach

| Option | Fixes | Determinism and testability | Cost, privacy and licensing | Product-truth risk | Outcome |
| --- | --- | --- | --- | --- | --- |
| A. Deterministic geometric fit from the alpha mask. Filter components, find the tight extent, estimate rotation with a minimum-area rectangle, snap to the template axis within a correction limit, scale to the template box, align to an anchor and resample once. | Rotation (small tilts), scale, centering and placement | Pure function. Unit-testable in Node and reproducible | $0. No new download. Image bytes stay in the browser | None. Rotation, uniform scale and translation only. No mirroring | **Accepted** as the post-processing step of every fit and the fallback when the model is unavailable (D-a) |
| B1. In-browser neural network (for example keypoints, orientation or a refined mask) on WebGPU, reusing the background-removal stack | Semantic orientation, garment keypoints, mask refinement | Model-dependent. Its output feeds the deterministic module, so the persisted recipe is still produced and bounded by that module | $0 per image. One extra on-demand download. Image bytes stay in the browser. The licence must permit this use; research-only weights (for example DeepFashion2-trained) are excluded | Low, limited to geometry | **Accepted** as the fitter (D-a). Model selection pending the model spike |
| B2. Hosted multimodal LLM (vision API) suggests the orientation or transform | Semantic cues | Non-deterministic, and poor at precise angles | Paid per image and needs a key. Supplier photos would go to a third party | Low if limited to geometry | **Rejected** (D-a: no server-side or paid AI) |
| C. Generative de-wrinkling or inpainting | Wrinkles | Non-deterministic | GB-scale models or a paid hosted API. Model licences vary | **High.** Changes how the product looks (fabric, print, fit) | **Rejected** (D-b) |
| C′. Non-generative smoothing filter (edge-preserving blur on fabric) | Mild crease softening | Deterministic | $0 | Medium. Changes texture and print detail | **Deferred** (D-b, later item L3) |

### Where fitting and rendering run

| Option | Notes | Outcome |
| --- | --- | --- |
| **Browser, beside the existing cutout worker (OffscreenCanvas)** | The cutout is already decoded there, so the preview is immediate. $0. Same privacy model as background removal | **Accepted** |
| Cloudflare Worker | There is no canvas. A WASM codec and resampler would weigh against bundle size and CPU limits. Decoding a 4000×3000 PNG does not fit free-plan CPU time. Cloudflare image transformations rotate only by 90° steps and are a metered product | Rejected |
| Separate image backend | A new service outside the ADR-0001 stack, with cost and operations | Rejected |

### What the server stores

| Option | Notes | Outcome |
| --- | --- | --- |
| **Baked derivative.** The browser renders a template-sized PNG. The server verifies the source digest and stores a new R2 object whose metadata links `cutoutUrl`, `originalUrl` and the fit recipe | Every consumer (cards, Worker HTML, structured data, sitemap images) sees the same pixels with no change. The recipe allows audit and a later re-render when a template changes. The original stays restorable | **Accepted** |
| Non-destructive transform stored in the overlay, applied by CSS at display time | No new binaries, and template edits re-apply instantly. But every renderer (React card, detail page, Worker SSR gallery, JSON-LD and social previews) must implement the same transform. The public projection would gain new fields, and cropping at the card edge becomes unpredictable | Rejected for now. Revisit for bulk re-templating |
| Server re-renders and compares pixels | Needs server-side image processing (rejected above). Adds no security, because managers with `media.upload` can already upload arbitrary images | Rejected |

### Template storage

| Option | Notes | Outcome |
| --- | --- | --- |
| **Code-bundled templates in `packages/catalog/picture-templates.js`, bound to stable category IDs with ancestor inheritance and a global default** | Pure, versioned by `revision`, reviewable in PRs and shared by browser and Worker validation. Manager-created categories inherit from their nearest bound ancestor | **Accepted** (D-f) |
| D1 manager-editable template state (a singleton like `taxonomy_state`, with revision, preview and audit) | Managers can tune templates without a deploy. Needs a new migration, a permission (`templates.edit`), an editor UI and a validation schema | **Deferred** (D-f, later item L2) |

## Decisions

The lead accepted the suggested defaults. Each item records what was decided.

- **D-a. Fitter: an in-browser neural network, with the deterministic mask fit as post-processing and fallback.** The fitter is a neural network that runs in the manager's browser on WebGPU. It reuses the background-removal stack: onnxruntime-web, on-demand download with version-pinned Cache API caching (failures are not cached), WebGPU first with a fresh WASM worker as fallback, cancel that terminates the worker, a per-attempt deadline, and the editor locks. There is no server-side or paid AI, and image bytes never leave the browser. The deterministic mask fit (`packages/catalog/picture-fit.js`) is the post-processing step of every fit: the model's output is turned into inputs of that module, and `computeFit` remains the only producer of the persisted recipe. `validateFitRecipe`, the template bounds and the stored recipe are therefore the same whether or not the model ran. If the model cannot load, fails on both WebGPU and WASM, or misses its deadline, the editor falls back to the mask fit alone and says so. Cancel aborts the whole job and does not fall back. **Model selection is pending a separate model spike.** That spike runs on another branch and amends this record with the chosen model, its licence, download size and latency, the exact mapping from model output to fit-module input, and whether that mapping needs an additive `picture-fit.js` change (with a `FIT_VERSION` bump if the recipe semantics change). This record does not choose a model.
- **D-b. Wrinkle removal is not offered.** Pictures show the product as photographed. Smoothing and generative de-wrinkling (L3) are deferred. Generative editing would need a new ADR.
- **D-c. Output canvas: 3:4, 1200×1600, stored as a transparent PNG.** It matches the storefront's 3:4 `object-fit: cover` cards, so nothing is cropped. The storefront applies any uniform background or styling.
- **D-d. The architect drafts the frames (templates), below.** Rollout order: footwear and pants first, then tops, then accessories. **Mirroring: never**, because logos and text would reverse. The lead left the scale rule to the architect; the default and its rationale are in [Scale rule](#scale-rule).
- **D-e. Normalization is per photo in the editor only.** Bulk normalization (L1) is deferred.
- **D-f. Templates are edited in code through PRs.** D1 editing (L2) is deferred.

### Scale rule

**Default: `scale.mode = 'contain'` with `maxUpscale = 1.5`.** A template may override the mode to `height` or `width` only when its category has a shared alignment line and a dominant dimension that should match across items. The override is always capped by `contain`. `area` stays in the schema, but no template uses it.

Rationale:

- **Visual consistency comes from the frame, not from the scale mode alone.** Every item in a template shares the same box and anchor. With `contain`, the item's dominant dimension (relative to the box aspect) fills the box. Side-view shoes are wider than the footwear box aspect (1056×736 px, about 1.43:1), so every shoe reaches the same length and stands on the same baseline. That is the consistency the lead asked for, without per-item tuning.
- **Nothing is ever cropped.** `contain` keeps the placed extent inside the box, the box lies inside the canvas, and the canvas has the same 3:4 aspect as the storefront card, so `object-fit: cover` shows the whole canvas. `height` and `width` are capped by `contain` for the same reason.
- **It is robust to mask quality.** `contain` uses only the transformed hull extent. `area` depends on the foreground pixel count, which changes with soft edges, a shoe pair versus a single shoe, bag handles and holes, so equal products would land at different sizes. That is why `area` is not a default.
- **`height` for pants.** Trousers share a waistband line (top-centre anchor) and should read as full length. They are usually narrower than the box aspect (768×1440 px, about 0.53:1), so `height` and `contain` mostly agree. `height` states the intent, and the `contain` cap still handles wide-leg or folded pants.
- **`maxUpscale` trades consistency for sharpness on purpose.** The automatic scale never enlarges a source by more than 1.5×. For footwear, the cap binds only when the shoe's long extent is under about 704 px (1056 / 1.5). For pants, it binds when their height is under 960 px (1440 / 1.5). Such items stay smaller than the box, on the same anchor, with the `upscaled` flag. The manager can then deliberately enlarge with the manual scale nudge (×0.5 to ×2, not subject to `maxUpscale`). Silently publishing soft, blurry enlargements would look worse in a uniform grid than a slightly smaller item.
- **Real size is not preserved within a template.** A small and a large item of the same template fill the same box. This is an accepted consequence (below).

### Approved frame set

The canvas is 1200×1600 for every template. Box values are canvas fractions (x, y, w, h). The values match `packages/catalog/picture-templates.js` revision 1. Any geometric change bumps the template `revision` (and `PICTURE_TEMPLATES_REVISION` for a bundle-wide change) and adds a new `id@revision` entry to the append-only snapshot test. Existing entries are never edited.

| Wave | Template | Bound categories | Box | Anchor | Scale | Axis / max correction / min elongation | Multiple objects | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `footwear-side` | `footwear` and all children | .06,.30,.88,.46 | .5,1 (bottom-centre) | contain, ≤1.5 | horizontal / 20° / 1.3 | allow (pairs) | **Approved, definitive** |
| 1 | `pants-vertical` | `pants` and all children | .18,.05,.64,.90 | .5,0 (top-centre) | height, ≤1.5 | vertical / 15° / 1.3 | flag | **Approved, definitive** |
| — | `default` | `default`, `unclassified`, unknown or null IDs, and unbound categories (`hats-caps`, `socks-underwear`, `gloves`, `jewellery`) | .10,.10,.80,.80 | .5,.5 (centre) | contain, ≤1.5 | none | flag | Active fallback. Values may change with a revision bump |
| 2 | `tops-front` | `outerwear`, `hoodies-sweatshirts`, `knitwear`, `tshirts-polos`, `shirts` | .08,.08,.84,.84 | .5,0 | contain, ≤1.5 | vertical / 8° / 1.15 | flag | Later wave. Bundled; values may change with a revision bump |
| 2 | `suits-front` | `suits` | .10,.05,.80,.90 | .5,.5 | contain, ≤1.5 | none | flag | Later wave. Bundled; values may change with a revision bump |
| 3 | `bags` | `bags` | .12,.20,.76,.62 | .5,1 | contain, ≤1.5 | none | flag | Later wave. Bundled; values may change with a revision bump |
| 3 | `accessory-wide` | `belts`, `glasses` | .08,.30,.84,.40 | .5,.5 | contain, ≤1.5 | horizontal / 20° / 1.3 | flag | Later wave. Bundled; values may change with a revision bump |

Later-wave templates stay bundled and bound, so their categories get a category-shaped fit now instead of the generic default. A wave is confirmed when previews on real inventory look right. Any change then is a revision bump, never an in-place edit. No template mirrors.

## Decision

1. **Fitter** (D-a). An in-browser neural network (model pending the model spike) proposes the fit. The deterministic mask fit post-processes it and is the fallback. Rotation from the mask comes from the minimum-area rectangle of the filtered foreground, never from PCA; PCA eccentricity is only a confidence signal. Rotation applies only when the template defines an axis, the shape is elongated enough (`minElongation`) and the correction is within `maxCorrectionDeg` plus `LIMIT_TOLERANCE_DEG` (0.25°, an estimation-noise allowance). Otherwise rotation is 0 and a quality flag is raised. Scale and placement always apply. There is no mirroring, no warping and no RGB editing.
2. **Pure module plus separate render.** `packages/catalog/picture-fit.js` takes the alpha channel and a template and returns transform parameters and quality metrics. A browser-only render step (`apps/web/src/picture-render.js`) applies the affine transform once from the cutout, never from an earlier normalized image, and encodes a lossless transparent PNG on the template canvas.
3. **Persistence.** A new endpoint, `POST /api/admin/products/:id/normalized` (permission `media.upload`), accepts the rendered PNG, the source cutout URL and its digest, and the fit recipe. The server checks that the source is this product's R2 cutout with archival lineage. It may be in the current photos, or be the recorded `cutoutUrl` of a normalized photo that is, so re-fitting keeps working after the cutout has been replaced. The same lineage-aware rule applies to `GET …/image`. A normalized object is never accepted as a source. The server verifies the digest (409 on mismatch), the PNG signature and that the PNG dimensions equal the template canvas. A stale template revision returns 409. The strict `validateFitRecipe` then runs (serialized recipe at most 1024 bytes, checked first; any failure is 400), and the server stores the **canonical copy it returns**, never the request input. The new object's metadata holds the lineage and that canonical recipe (400 if the serialized metadata exceeds 1800 bytes). The server audits `media.normalize`. The lineage check is the security boundary; the digest is an integrity echo. As with the cutout flow, the product changes only when the manager saves the photo list. `image-originals` additively reports lineage, so "Restore original" and "Back to cutout" both work.
4. **Templates** are code-bundled and changed through PRs (D-f). Resolution order: resolve retired IDs, then the category itself, then its ancestors from nearest to root, then `default`. On a binding collision (a retired key redirected onto a category that has its own binding), the current key wins. A missing taxonomy context falls back to the seeded `CATEGORY_TREE`. Unclassified products get the `default` template. The frame set is above.
5. **Fitting needs a saved cutout.** The fit button works only on photos saved into the product. Unsaved photo changes must be saved first.
6. **The manager stays in control.** The manager sees a before/after preview with the template guide overlay, the quality flags and whether the model or the mask-only fallback produced the fit. Manual nudges (rotate, scale, offset) are available within bounds. "Keep cutout" and "Restore original" are always available. Nothing is applied in bulk (D-e).
7. **Out of scope:** wrinkle removal (D-b), bulk normalization (D-e), D1 template editing (D-f) and any server-side or paid AI (D-a).

## Consequences

- No migration, paid service, server-side model or public-projection field. One new admin route and one permission-table entry. One new on-demand in-browser model download (selected), cached and version-pinned like the IS-Net model, and never preloaded.
- Normalized pictures are new R2 objects. They are private until they are referenced by a published product's effective photos, exactly like cutouts. Storage grows by one PNG per normalized photo, and nothing is deleted automatically.
- Rotated objects are measured by their transformed convex hull, not by a rotated bounding box, so placement and scale are exact for tilted items.
- The server stores what the manager previewed. It does not prove the pixels came from the recipe. This is the same trust level as existing manager uploads, and the recipe plus lineage keep the result auditable and re-renderable.
- Browser canvas resampling is not bit-identical across browsers, and model output may differ between WebGPU and WASM. The deterministic module is reproducible for a given input, but the rendered bytes are not. Tests target the pure module, plus tolerance-based checks for rendering and the model path.
- Changing a template's geometry bumps its `revision`. Existing normalized photos keep their recorded revision until a manager re-fits them. Bulk re-fit is a later, lead-gated feature.
- Within a template, every item fills the same box. A small item such as a belt and a large one such as a boot will look the same size within their own templates. Real-size cues are lost by design.
- Low-resolution sources may stay smaller than the box (`upscaled` flag) rather than being enlarged beyond 1.5×.
- The shared files `apps/api/src/index.js`, `apps/api/src/permissions.js`, `tests/backend/permissions.test.js`, `package.json` (test script), `docs/API.md`, `docs/adr/README.md`, `docs/ARCHITECTURE.md` and `apps/web/src/styles.css` overlap with other epics. The cart epic (ADR-0007) is already on main and has added its routes, permission rows, test-script lines and doc sections to these files, so ADR-0008 tasks add their entries beside the existing media/cutout entries and merge current main before review. The model spike also amends this ADR on another branch. The orchestrator serializes these merges.

## Revisit triggers

- The model spike finds no model that meets its licence, size or latency budget. Then the mask fit ships alone and this record is amended.
- In real use, quality flags mark more than about 20% of a category for review, or the 180° and mirror cases (toe direction, upside-down) are common even with the model.
- The lead asks for wrinkle softening (L3), bulk normalization (L1) or template editing without a deploy (L2).
- Template changes become frequent, or bulk re-templating is requested. Then reconsider the non-destructive transform, or a re-render queue driven by the stored recipes.
- Public media gets CDN caching or responsive variants. Then the canvas size and encoding (PNG vs WebP with alpha) need revisiting.
