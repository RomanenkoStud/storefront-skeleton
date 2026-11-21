# Media

This document describes product photo storage, public media rules, background removal, picture fit and card thumbnails.
For the HTTP contract, see [API.md](API.md).

## R2 layout

The Worker binding `MEDIA` is the photo bucket (`lorem-store-media`, staging `lorem-store-media-staging`). `tools/cloudflare-config.mjs` adds the binding from the deploy variables (`CLOUDFLARE_R2_BUCKET`, `STAGING_R2_BUCKET`). Without `MEDIA`, uploads and cutouts return `503`.

| Key | Content | Written by |
| --- | --- | --- |
| `<uuid>.<jpg\|png\|webp>` | Uploads, archived originals, cutouts (PNG), normalized pictures (PNG) | Worker (`storeMedia`, `saveNormalized`), `tools/stockify.mjs` |
| `<32 hex>-<16 hex>.card.webp` | Card thumbnails | `tools/card-thumbnails.mjs` only |
| `campaign/<uuid>.<png\|webp>` | Campaign band pictures (`campaign_pictures`) | Worker |
| `storefront/<uuid>.<png\|webp>` | Storefront slot images (`storefront_images`) | Worker |
| `np-catalog/v1/…` | Nova Poshta snapshot, only when `NP_CATALOG` is not bound. See [INTEGRATIONS.md](INTEGRATIONS.md#nova-poshta-catalog-sync). | `tools/np-catalog-sync.mjs` |

The Worker never overwrites a key. A product photo URL is `/media/<key>`.

**Lineage (R2 `customMetadata`).** A product upload has `productId`. A cutout adds `originalUrl` and `sourceUrl`. A normalized picture has `productId`, `originalUrl`, `cutoutUrl`, `templateId`, `templateRevision`, `fitVersion` and `recipe`. Keep R2 metadata in backups. The restore and re-fit actions need it.

## Media tracking, dedup and purge

Migration `0014_media.sql` adds these tables. Code: `apps/api/src/media.js`.

| Table | Purpose |
| --- | --- |
| `media_objects` | One row per tracked `<uuid>` object: size, type, SHA-256, kind (`upload`, `original`, `cutout`, `normalized`, `unknown`), product, lineage keys |
| `media_refs` | Every `/media/` photo of every product (source and overrides, also Trash). Triggers on `products` keep it current. |
| `product_tombstones` | Purged products. Imports and syncs never create them again. |
| `media_state` | Time of the last complete scan |

**Dedup.** `storeMedia` hashes the bytes. Uploads and archived originals reuse an object with the same hash and type. Cutouts and normalized pictures reuse an object only with the same product and lineage. A reused object gets a new `touched_at`.

**Live objects.** An object is live when a product photo or a cart line refers to it, or when it is the original or cutout of a live object.

**Automatic delete.** A product save that removes a photo, and a product purge, delete the removed objects and then their lineage. The delete happens only when nothing refers to the object in the same D1 statement. R2 is deleted after the row.

**Media library** (admin, `media.list` with `media.read`; scan and cleanup with `media.manage`, owner only):
1. Scan R2 (`POST /api/admin/media/scan`, 20 objects per page, resumable cursor). This tracks objects that have no row.
2. Read the list (`GET /api/admin/media`). It shows live objects, orphans, duplicates and untracked objects.
3. Clean up (`POST /api/admin/media/cleanup`, `confirm: true`, at most 200 keys).
   - An orphan is deleted only after a 24-hour grace period.
   - Cleanup merges a duplicate: it points product overrides to the survivor, then deletes the copy.
   - Cleanup does not merge a copy that a cart line, a lineage or a supplier source uses.

The media library tracks only `<uuid>` keys. It does not track card thumbnails, campaign or storefront images.

## Public media rules and cache headers

`serveMedia` in `apps/api/src/index.js` serves `GET /media/<key>`.

**Who can read.**
- Cloudflare Access, or staff with `media.read`: every key.
- Anonymous visitors:
  - product photo: only when a published product of an enabled supplier shows the URL in the storefront (`isPublicMedia`: `media_refs` lookup, then the merged storefront projection);
  - card thumbnail: only when its source is `photos[0]` of a product in the public catalog (`isPublicCardThumbnail`);
  - campaign or storefront image: only when a `campaign_pictures` or `storefront_images` row refers to the key.
- The customer cookie is never a credential.
- All other requests get `404`.

| Response | `Cache-Control` |
| --- | --- |
| Private access (Access or staff) | `no-store` |
| Public product photo | `public, max-age=31536000, immutable` |
| Public campaign or storefront image | `public, max-age=3600` |
| Public card thumbnail | `no-store` |

Every response has `X-Content-Type-Options: nosniff` and, when R2 gives one, the `ETag`. Anonymous requests with `If-None-Match` or `If-Modified-Since` can get `304`.

## Background removal

Background removal runs in the manager's browser. Image bytes never go to a third-party service.

**Runtime** (`apps/web/src/background-removal.js`, `background-removal.worker.js`):
- Model: IS-Net FP16 from Hugging Face `imgly/isnet-general-onnx`, pinned revision `440dea96`, about 88 MB.
- Runtime: `onnxruntime-web` 1.21.0 from jsDelivr.
- WebGPU first. If it fails, a fresh WASM worker (one thread).
- Download only after the manager clicks the action. Never on page load.
- Cache API name `catalog-isnet-440dea96-ort-1.21.0`. The worker caches only successful responses.
- Deadline: 180 seconds per attempt. Cancel stops the worker.
- Output: lossless PNG with the original size and RGB. Only the alpha changes.
- Licences: `apps/web/public/licenses/background-removal.txt`.

**Procedure (one photo, `ImageCutout.jsx`).**
1. The browser gets the original through `GET /api/admin/products/:id/image?url=` (`media.read`).
   - The URL must be a photo of this product, or the `cutoutUrl` of a normalized photo of this product.
   - `/media/` keys are read from R2.
   - Supplier URLs: only `https://backend.mydrop.com.ua/vendor/products/uploads/<file>` and canonical `https://easydrop.one/media/uploads/images/<dir>/<file>`. No redirects, 20-second timeout, 20 MB maximum, image signature check.
2. The browser removes the background and computes the SHA-256 of the original.
3. The manager compares the preview on transparent, white or cream backgrounds.
4. Accept sends `POST /api/admin/products/:id/cutout` (`media.upload`) with `sourceUrl`, `originalHash` and the PNG.
5. The server gets the original again. If the hash is different, it returns `409`.
6. The server archives a supplier original once. An own `/media/` original is not copied.
7. The server stores the cutout and returns `{url, originalUrl}`. The product does not change.
8. The manager saves the product photo list. "Відновити оригінал" uses `GET …/image-originals`.

**Batch cutout** (`BatchCutout.jsx`, `batch-cutout.js`) runs the same steps for selected products in sequence. It uses the first photo or all photos. It skips photos that already have a cutout. It rejects a mask that is more than 99% or less than 1% transparent. Campaign pictures and storefront images use the same browser processor.

## Picture normalization (fit)

The fit places a saved cutout on a 1200×1600 transparent PNG canvas by the category template. It rotates a little, scales uniformly and aligns an anchor. It never mirrors, warps or changes RGB values. It runs for one photo at a time.

| Part | File |
| --- | --- |
| Templates | `packages/catalog/picture-templates.js` |
| Fit module (pure) | `packages/catalog/picture-fit.js` (`analyzeMask`, `computeFit`, `validateFitRecipe`, `FIT_VERSION = 1`) |
| Fitter seam | `apps/web/src/picture-fitter.js` (`proposeFit`, mask fit only) |
| Render | `apps/web/src/picture-render.js` |
| Editor UI | `apps/web/src/PictureFit.jsx` |
| Server | `saveNormalized` in `apps/api/src/image-processing.js` |

**Templates.** Bound categories: `footwear` → `footwear-side`, `pants` → `pants-vertical`. All other categories use `default` (centred, `contain`, no rotation). The templates `tops-front`, `suits-front`, `bags` and `accessory-wide` exist but have no binding. A child category uses the binding of its nearest bound ancestor. A geometric change needs a new `revision`.

**Fit result.** `computeFit` returns the recipe: transform, matrix, manual nudge, placed box and quality. The quality level is `ok`, `review` or `unsupported`. Flags: `empty-mask`, `multiple-objects`, `fragmented`, `edge-clipped`, `rotation-ambiguous`, `rotation-over-limit`, `aspect-mismatch`, `upscaled`, `soft-mask`.

**Procedure.**
1. Save the cutout into the product photos first.
2. Click the fit action. The browser analyses the alpha mask and computes the fit.
3. Adjust rotation, scale and offset if necessary. Nudges do not run the analysis again.
4. Accept sends `POST /api/admin/products/:id/normalized` (`media.upload`) with `sourceUrl`, `sourceHash`, `recipe` and the PNG.
5. The server checks:
   - the source is a saved cutout of this product, not a normalized picture (`400`);
   - the source hash (`409` if changed);
   - the template exists (`400`) and has the same revision (`409`);
   - the recipe is at most 1024 bytes and passes `validateFitRecipe` (`400`);
   - the PNG size equals the template canvas (`400`);
   - the metadata is at most 1800 bytes (`400`).
6. The server stores the PNG with lineage metadata and returns `201 {url, cutoutUrl, originalUrl}`.
7. The manager saves the product photo list.

A re-fit always starts from the cutout, never from a normalized picture.

## Card thumbnails

A nightly job makes a small WebP copy of the first photo of each published product. Product cards use `cardPhoto`. The product page keeps the original.

| Item | Value |
| --- | --- |
| Tool | `tools/card-thumbnails.mjs` (`npm run thumbs`), pure logic in `tools/card-thumbnails-core.mjs` |
| Workflow | `.github/workflows/card-thumbnails.yml`: production nightly at 01:40 UTC; manual dispatch for production or staging; `main` only |
| Table | `photo_derivatives` (migration `0019_photo_derivatives.sql`), variant `card` |
| Output | Long edge at most 800 px (no enlargement), WebP quality 75, alpha kept |
| Key | `<sha256(source URL), 32 hex>-<sha256(source bytes + params), 16 hex>.card.webp` |
| API | `cardPhoto` on `/api/products` and `/api/products/:slug`. `null` when there is no thumbnail. |

**Secrets and variables (names only).** `CLOUDFLARE_ACCOUNT_ID`, `THUMBS_CLOUDFLARE_API_TOKEN` (production), `STAGING_THUMBS_CLOUDFLARE_API_TOKEN` (staging). Variables: `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_R2_BUCKET`, `STAGING_D1_DATABASE_ID`, `STAGING_R2_BUCKET`. The token needs D1: Edit and Workers R2 Storage: Edit. Without the token, the job writes a notice and succeeds. The job never uses the deploy tokens.

**Behaviour.**
- It selects first photos of published products of enabled suppliers that have no current `card` row. Default limit 300 per run, maximum 5000, concurrency 4.
- It downloads through `tools/safe-download.mjs`: public HTTPS only, at most 3 redirects, private and reserved addresses rejected, connection pinned to the checked address. 30-second timeout, 25 MB maximum.
- If the WebP is not smaller than the original, it stores a row with `url` NULL. The card keeps the original.
- A row with other params is made again under a new key. The order is: upload, update the row, delete the old object.
- It removes rows and objects whose source is no longer a first photo (not with `--no-prune`).
- The job logs a broken photo and tries it again in the next run. The exit code is non-zero only for bad config or repeated Cloudflare failures.
- It does not detect a new image behind the same URL. Use `--force`.

**Run locally.**
1. Set `CLOUDFLARE_ACCOUNT_ID`, `THUMBS_CLOUDFLARE_API_TOKEN` and, if necessary, `THUMBS_D1_DATABASE_ID`.
2. Run `npm run thumbs -- --env staging --limit 20 --dry-run`. The default environment is `prod`.
3. Remove `--dry-run` to write. Options: `--env prod|staging`, `--limit N`, `--force`, `--no-prune`.

**Run from GitHub (go-live).** Production runs need lead approval.
1. Create the token for the environment.
2. Run `gh workflow run card-thumbnails.yml --ref main -f environment=staging -f dry_run=true`. Leave `limit` empty.
3. Read the step summary. Then run again with `dry_run=false`.
4. Check that cards load `.card.webp` and `/api/products` shows `cardPhoto`. Then repeat for `environment=production`.

**Rollback.** Remove the thumbnail token to stop new runs. To withdraw served thumbnails, delete the `card` rows in `photo_derivatives`. Then every `.card.webp` URL returns `404` and cards use `photos[0]`.

## Stockify (local utility)

`tools/stockify.mjs` (`npm run stockify`) makes a clean studio picture of a product photo with the local `codex` CLI image generation. It is not part of the Worker or of CI.

1. Log in to the `codex` CLI. Put `CLOUDFLARE_API_TOKEN` in `.dev.vars`.
2. Run `npm run stockify -- <productId|supplierNumber> [--env prod|staging] [--photo N] [--primary] [--dry-run]`. The default environment is `prod`.
3. The tool uploads `<uuid>.<ext>` to R2 and adds the URL to the product photo overrides (`--primary` puts it first). It writes the audit action `media.stockify`.
4. `--dry-run` saves the picture locally and uploads nothing. Exit code 75 means the Codex plan limit; run again later.

The tool does not write `media_objects`. The object stays untracked until the next media library scan.
