# ADR-0012: Merged storefront listing for confirmed duplicate groups

Status: **Accepted**. The lead approved the proposed defaults. This builds on the duplicate review and changes the public projection and cart snapshot of [ADR-0007](0007-customer-cart-checkout.md) as described below. No paid service, sync behaviour or supplier-side change is involved.

## Context

Several suppliers can carry the same item, so the storefront showed duplicates. The duplicate review lets managers confirm a duplicate group: at most one product per supplier, stored in `duplicate_groups` and `duplicate_group_members`. The lead asked that a confirmed group appear on the site as one product, with each supplier's quantity added to the others'.

## Decision

The merge is computed on every read in `apps/api/src/merged.js`. Nothing about it is stored, and members' publication flags, overlays and source snapshots are never written. Dissolving a group therefore restores the earlier storefront exactly.

1. **Members.** A member contributes when it is **published**, not in Trash, and its supplier is enabled and not in Trash. A disabled supplier, a trashed member or an unpublished member drops out automatically. Drafts never become purchasable through a group, because public responses must exclude drafts (AGENTS.md).
   - **Loss guard.** A member whose supplier cost is higher than the shown price is also left out, so the merged product is never filled at a loss.
2. **Visibility.** A group is on the storefront when at least one contributing member exists. A group with no published member is not shown. In practice the duplicates were visible because several members were published, so each of those adds its stock.
3. **Shown product (primary).** The primary is the published contributing member that has visible stock, then the lowest supplier cost, then the lowest ID. Its public projection supplies the title, description, photos, slug, SEO fields, category, brand, promotion and price. The primary can change when stock or costs change. Other members' slugs keep working:
   - `/products/<member>` returns `301` to the primary;
   - `/api/products/<member>` returns the merged product.
4. **Price.** The primary's own markup applied to the primary's own cost. Price is unchanged when another supplier fills the order; the manager sees each supplier's cost on the cart.
5. **Sizes.** Each contributing member's visible variants (its hidden sizes excluded) are grouped by `sizeMergeKey`. This is the storefront's existing `normalizeSize`, now in `packages/catalog/sizes.js`, or the trimmed upper-case label when a size is not recognised. Stock is summed per key. The label comes from the primary when the primary has that size, otherwise from the first member that does. Sizes that do not normalize to the same key stay separate.
6. **Checkout.**
   - **Resolution.** Any member ID resolves to the group's storefront product, so carts saved before grouping keep working. Two lines that resolve to the same product and size return `duplicate_line`.
   - **Size.** A merged product is ordered by one of its shown size labels.
   - **Fill order.** The quantity is filled from members in order of lowest supplier cost, with the primary winning ties. Availability is checked against the summed stock.
   - **Snapshot.** The line stores the primary's product ID, slug, title, photo and price. The existing single-supplier columns hold the first supplier part. The full split is in the new private `cart_lines.allocations_json` (`migrations/0017`): `[{productId,supplierId,supplierName,externalProductId,variantIds,quantity,unitCostMinor}]`. It is `NULL` for ordinary lines.
   - **Staff view.** The staff cart detail shows one line per supplier part (`merged:true`, `sourceProductId`), so the existing per-supplier hand-off groups them correctly. Customer and public responses are unchanged and never include the split.
7. **Public surfaces.** The `/api/products` list, product pages, sitemap and public media access all use the merged catalog. Hidden members do not appear in the list or the sitemap, and their own uploaded photos are not public through the merged product.

## Consequences

- One extra `LEFT JOIN` on public reads. Detail and checkout load only the affected group.
- Dissolving a group, or removing a member, immediately restores separate listings.
- The primary, and so the canonical URL, can move between members. Old member URLs redirect, so links stay valid.
- Stock is not reserved, as in ADR-0007. A split order still needs manual confirmation with each supplier.

## Not decided

- Manager-pinned primary: there is no override; the rule above always applies.
- Price policy other than the primary's own markup.
- Whether draft members should also add stock. They don't: a manager publishes a member to let it contribute.
- Automatic supplier ordering.
