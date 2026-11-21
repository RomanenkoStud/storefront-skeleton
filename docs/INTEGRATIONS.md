# Integrations

This document describes the supplier providers, the supplier sync and the Nova Poshta catalog sync.
For the HTTP contract, see [API.md](API.md). For data ownership, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Supplier providers

Each supplier row has one `provider`. The manager sets it when the supplier is created. A later PATCH cannot change it.

| Provider | Source | Code |
| --- | --- | --- |
| `mydrop` | MyDrop dropshipper export, JSON | `apps/api/src/mydrop.js`, `syncSupplier` in `apps/api/src/index.js` |
| `easydrop` | EasyDrop prom-export feed, XML | `apps/api/src/easydrop.js`, `apps/api/src/easydrop-link.js`, `syncEasyDrop` |
| `manual` | No feed. Managers create and edit the products. | `apps/api/src/manual.js` |

Migrations: `0015_supplier_provider.sql` adds `provider` and the EasyDrop feed columns. `0018_manual_supplier.sql` adds `manual`.

### MyDrop

**Source.** The Worker reads one connection catalog:
`GET https://backend.mydrop.com.ua/dropshipper/api/export/dropshipper_vendors/<connectionId>/products/json`.

**Auth and config.**
- Worker secret `MYDROP_API_KEY`. The Worker sends it in the `X-API-KEY` header. No response contains it.
- The staging deploy does not receive `MYDROP_API_KEY`.
- Each supplier needs a `connection_id`. This is `dropshipper_vendors[].id`. It is not the `vendorId` and not the public page slug.
- "Sync connected suppliers" reads `GET .../dropshipper_vendors`. It stores only the connection ID, the vendor name and the public URL. It matches local rows by connection ID first, then by public URL. It skips unverified connections, suppliers in Trash and ambiguous matches, and reports them. It never imports products.

**Mapping into products.**

| SourceItem field | MyDrop field |
| --- | --- |
| `externalId` | product `id` |
| `category` | `category_id` resolved through `categories[]`. Unknown or empty: `Без категорії`. |
| `costMinor` | `drop_price` in UAH, converted to kopecks (half-up). A string can use a decimal comma. |
| `photos` | `images[].full_url`, then size and bundle component images. HTTPS only, no duplicates, at most 30. |
| `variants` | `sizes[]`: `id`, label (`formatted`, `title` or `sku`), stock `real_count_dropshipper`. |

- Stock: a digit string is accepted. A negative value becomes 0. A missing or unknown value is 0.
- A product without sizes gets one variant `default` ("Один розмір").
- A bundle (`is_set` not false, or non-empty `child_products`) gets matched sizes. A bundle size exists only when every sized component has that size. One-size components join every size. Stock is the minimum of `floor(stock / units)` over the components. The private variant ID is `set:<componentId>.<sizeId>+…`.

**Skipped products.** The sync skips one product, not the supplier, when:
- `drop_price` is missing, negative or not a number;
- the title is blank, or the product ID is invalid or repeated in the export;
- the sizes are all invalid, or there are more than 100;
- a bundle has no shared size, a bad component, or a variant ID longer than 200 characters.

The run note lists the skip count per reason.

**Limits.** 5,000 products, 100 variants per product, 8 MB response, 20-second timeout, no redirects, JSON content type only.
A `202` response means MyDrop is still generating the export. The run is `pending`. The scheduler retries after 15 minutes.

### EasyDrop

**Source.** A manager pastes the prom-export link of one supplier. Example shape:
`https://easydrop.one/prom-export?key=<digits>&pid=<digits>`. The `pid` part is optional.

**Auth and config.**
- The link is a capability URL. There is no Worker secret for EasyDrop.
- The server validates the link (`parseEasyDropLink`). It requires `https:`, host `easydrop.one`, path `/prom-export`, and only `key` and `pid` with 1–30 digits each.
- The server stores only `feed_key` and `feed_pid` in private D1 columns. It rebuilds the fetch URL from them (`buildEasyDropFeedUrl`). It never fetches the pasted string.
- Responses show only `feed: {configured, keyLast4, updatedAt}`. `keyLast4` is `null` for keys shorter than 8 digits. Staff without `suppliers.manage` see only `{configured}`.
- Error messages and logs never contain the key, the pid or the URL.
- A `(provider, feed_key)` pair is unique, also for suppliers in Trash. A duplicate gives `409`.
- `suppliers.url` is the synthetic value `easydrop:<supplier id>`.

**Mapping into products.** One `<item>` is one size. `group_id` joins the items into one product.

| SourceItem field | EasyDrop field |
| --- | --- |
| `externalId` | `group_id`. An item without a group becomes `o:<item id>`. A non-numeric group is skipped as `x:<group>`. |
| `title` | `<name>`, at most 300 characters |
| `description` | `<description>`, entities decoded and HTML converted to plain text, at most 20,000 characters |
| `category` | `<catalog><category>` text for `<categoryId>`, whitespace collapsed. Unknown: `Без категорії`. |
| `costMinor` | `<priceuah>` × 100. All sizes of a product must have the same price. Otherwise the product is skipped. |
| `photos` | `<image>` URLs on `easydrop.one/media/uploads/images/{base,itemimage,item_<n>}/…` only, at most 30 |
| `variants` | item `id`, size from `<param name="Розмір">` (or `Размер`), stock from `quantity_in_stock` |

- Stock is 0 when the item is not available or has no quantity.
- A repeated size label keeps the item with the most stock.
- A product with one item and no size gets "Один розмір". If a product has several items and one has no size, the sync skips the product.

**Limits.** 12 MB body, 20,000 items, 5,000 products, 5,000 categories, 20-second timeout, no redirects.
The response must be `200` with `text/xml` or `application/xml`. The parser rejects `DOCTYPE`, `ENTITY`, CDATA and processing instructions.
A redirect, another status, HTML or zero importable products fails the run. The inventory stays unchanged.

**Known limits.**
- The feed does not name the supplier. The manager selects the supplier record.
- The code cannot tell if `priceuah` is the drop price or includes a seller markup.
- A provider can serve the feed from an upstream cache. A sync can then import an old copy. The code does not detect this.
- The feed key is in the request URL. Keep Workers fetch tracing off, or redact the spans.

### Manual suppliers

- A manual supplier has no feed. Sync and JSON import return `409`.
- The manager enters the retail price (`priceMinor`) and an optional cost (`costMinor`). The default cost is the retail price.
- The server stores a fixed markup: `priceMinor − costMinor`. The price cannot be below the cost.
- The variant ID comes from the size label (`v-<slug>`), so it stays stable after edits.

## Pricing

All amounts are integer kopecks in UAH.

1. The supplier gives the cost (`source.costMinor`).
2. The retail price is cost + markup (`retailPrice` in `apps/api/src/domain.js`).
3. The default markup is `fixed` with value 0. So a new synced product has retail price = cost.
4. A manager with `products.price` can set `markupType` (`fixed` or `percent`) and `markupValue`.
5. A manager price override (`priceOverrideMinor`) replaces the computed price.

## Supplier sync

### Rules

- **Idempotent.** The sync upserts on `(supplier_id, external_id)`. A repeated sync of the same export gives the same rows.
- **Skips unchanged products.** When `source_json` is equal to the stored value, the sync writes nothing for that product.
- **Preserves manager overrides.** The sync writes only `source_json`. It never changes `overrides_json` (publication, price, photos, category, texts).
- **Keeps omitted products.** A product that the provider no longer lists stays in the catalog.
- **Respects Trash and purge.** The sync does not update a product in Trash. A tombstone (migration 0014) stops the sync from creating a purged product again.
- **Protects published products.** If new source data would make a published product invalid, the sync keeps that product unchanged and reports it (`published_invalid`).
- **Atomic.** All valid products of one run import in one D1 batch. If every product is skipped, the run fails and the inventory stays unchanged.
- **New products are drafts.** Nothing is published automatically.

### Cooldown

Each request to a provider claims `suppliers.last_api_request_at`. A second request within 15 minutes returns `429` without a fetch. Manual and scheduled syncs share this claim.

### Schedule

| Environment | Cron | Behaviour |
| --- | --- | --- |
| Production | `*/5 * * * *` (`wrangler.jsonc`) | Each tick selects up to 5 due suppliers, oldest `last_sync_at` first. |
| Staging | none (`env.staging.triggers.crons` is empty) | No automatic sync. `tools/cloudflare-config.mjs` rejects a staging cron. |

A supplier is due when all of these are true:
- it is enabled and not in Trash;
- it is `mydrop`, or `easydrop` with a feed key;
- it has no run yet, or its last run was 55 minutes ago or more (`SYNC_DUE_MS`), or its last run was `pending` 15 minutes ago or more.

So each supplier syncs about once per 60 minutes. The admin API reports `autoSync: {intervalMinutes: 60}` in production only.

**Query budget.** A tick has a budget of 800 D1 queries (`SCHEDULED_QUERY_BUDGET`). The first supplier always runs. A later supplier runs only if its estimate (product count + 10) fits in the remaining budget. A supplier with no products counts as the full budget. Deferred suppliers stay oldest and go first in the next tick.

Before the supplier sync, each tick runs the order retention job.

## Nova Poshta catalog sync

The delivery-point picker reads our own R2 copy of the Nova Poshta branch and postomat list. The Worker never calls Nova Poshta.

| Item | Value |
| --- | --- |
| Tool | `tools/np-catalog-sync.mjs` (`npm run np:sync`) |
| Workflow | `.github/workflows/np-catalog.yml`: daily at 00:30 UTC and manual dispatch, from `main` only |
| Upstream | `Address.getWarehouses` on `https://api.novaposhta.ua/v2.0/json/`, 500 records per page. No key is needed. `NOVA_POSHTA_API_KEY` is optional. |
| R2 layout | `np-catalog/v1/<snapshotId>/…` and the manifest `np-catalog/v1/current.json` |
| Worker binding | `NP_CATALOG` (bucket from `NP_CATALOG_BUCKET`). Without it, the Worker reads `MEDIA` (local development only). |
| Worker endpoints | `/api/delivery/np/cities`, `/api/delivery/np/warehouses` (`apps/api/src/nova-poshta.js`) |

**Secrets and variables (names only).**
- Production job: `CLOUDFLARE_ACCOUNT_ID`, `NP_CATALOG_R2_ACCESS_KEY_ID`, `NP_CATALOG_R2_SECRET_ACCESS_KEY`, variable `NP_CATALOG_BUCKET`.
- Staging job: `STAGING_NP_CATALOG_R2_ACCESS_KEY_ID`, `STAGING_NP_CATALOG_R2_SECRET_ACCESS_KEY`, variable `STAGING_NP_CATALOG_BUCKET`.
- Without the R2 key pair or the bucket variable, the job writes a notice and succeeds.
- The workflow never uses the deploy tokens. In GitHub Actions, the tool accepts only the R2 S3 key pair.

**Procedure (one run).**
1. Read the current manifest. If it exists and is not valid, stop.
2. Pull all pages from Nova Poshta.
3. Build the snapshot (`packages/catalog/delivery.js`).
4. Stop if the snapshot has zero points, or if a count is below 80% of the previous snapshot.
5. Upload the snapshot objects. Write `current.json` last. This publishes the snapshot.
6. Delete snapshots that are not the new or the previous one and are at least 10 minutes old.

**Local runs.**
- `--out <dir>` writes to a local directory and does not touch Cloudflare.
- `--staging` selects the staging bucket.
- `CLOUDFLARE_API_TOKEN` can replace the R2 key pair, outside GitHub Actions only.
- `--force` accepts a large drop or an invalid manifest. It is for local runs only.
