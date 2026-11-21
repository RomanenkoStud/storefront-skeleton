# Product scope

Lorem Store is a Ukrainian dropshipping storefront. Managers import products from suppliers, curate them and publish a selection. Customers browse, build a cart and get a cart code. A manager then places the supplier order by hand.

## Fixed rules
- The interface is Ukrainian. The only currency is UAH. Money is integer kopecks.
- There is no online payment, no automatic supplier ordering, no delivery booking and no stock reservation.
- The checkout can show a prepayment amount. The shop does not collect it online.
- Tax, currency conversion and shipping purchase are out of scope.
- Inference is local and deterministic. There are no paid model calls.

## Suppliers and import
- Supplier types: MyDrop (dropshipper API), EasyDrop (prom-export feed) and manual (no feed). See [INTEGRATIONS.md](INTEGRATIONS.md).
- Owners connect suppliers, rename them, enable or disable them, and move them to Trash. Owners can also discover connected MyDrop suppliers.
- Managers run a sync or a JSON import for one supplier. The production cron syncs every enabled feed supplier about once an hour.
- An import upserts the supplier snapshot. It never overwrites manager edits and never creates duplicates.
- New products are unpublished drafts. Products missing from a feed are kept.
- A disabled supplier hides its products. Re-enabling it restores them with their saved publication state.
- Managers create manual products and edit their source data. Manual products are never synced.

## Product management
- The cabinet lists products with supplier, publication, stock, category, brand and sync status. It has search, filters and 40-row pages.
- Managers edit title, description, category, brand, photos, hidden sizes, promotion, SEO fields, slug and internal tags.
- Clearing a field returns it to the supplier value. The editor shows supplier values beside effective values.
- Price: fixed or percentage markup on the cost, or a fixed price override. Clearing the override returns to markup.
- Promotions have text, a start, an end and a free-shipping flag. They do not change cart totals.
- Bulk actions apply to up to 50 selected products: publish, unpublish, Trash, restore and tags. Mixed invalid input fails as a whole.
- Trash is reversible. Restored products are drafts. Restored suppliers stay disabled. Only owners purge from Trash.
- Destructive actions show the affected names and counts and need confirmation. Trash never deletes anything at the supplier.
- Managers cannot invent stock. Sizes and stock come from the supplier; managers can only hide sizes.

## Categories and recognition
- The category tree is stored in D1 and is editable: create, rename, move, reorder and delete with a replacement.
- Retired category IDs keep resolving to their replacement. Only owners delete categories.
- Category and brand suggestions use supplier text and the title. The editor shows the rule, the reason and the confidence.
- Managers preview suggestions for selected products and apply them only where no manual value exists.
- Owners activate a recognition version for the whole catalog after a preview of the publication impact.

## Photos
- Products use supplier image URLs by default. Managers can upload photos to R2 and order them.
- The browser removes backgrounds and fits photos to category templates. There is no server-side AI.
- Card thumbnails are generated daily from the first photo. Product pages keep the original photos.
- Owners scan the media library and delete unreferenced files. See [MEDIA.md](MEDIA.md).

## Duplicates
- The «Дублікати» section lists likely duplicates across suppliers, with their evidence.
- Managers confirm a group (at most one product per supplier), reject a pair or dissolve a group.
- A confirmed group shows as one storefront product: the cheapest published member in stock. Stock adds up by normalized size.
- Checkout splits a line across members by lowest cost. Other members' pages redirect to the shown product.

## Storefront
- Pages: landing, catalog with category tree, product pages, cart, customer cabinet. Layout works on desktop and mobile.
- Filters: category (with descendants), brand, available size and price range. Dimensions combine with AND. Filters stay in the URL.
- Only published products of enabled suppliers appear. Drafts never reach APIs, product HTML, structured data or the sitemap.
- Owners set the campaign band, ticker, sale banner, prepayment amount and storefront images.
- Visual rules are in [design/DESIGN.md](design/DESIGN.md).

## Cart and orders
1. The visitor adds a size and a quantity (1 to 10). A cart holds up to 20 lines and stays in the browser.
2. At checkout the server checks each line: published, supplier active, size visible, enough stock. The server sets the prices.
3. If a line fails, nothing is created and the page shows each problem.
4. On success the visitor gets a code such as `SS-7K3M-Q9TB` and a ready message for a manager.
5. The visitor can choose a Nova Poshta branch or postomat. For signed-in customers, the cart also stores it and the recipient (full name, phone).
6. Staff find a cart by code and see its lines by supplier, with costs. Statuses: «Перевірено», «Передано постачальникам», «Виконано» or cancelled.
7. Recipient and delivery data are erased 14 days after completion or cancellation, or 90 days after the order.

## Accounts and staff
- Customers sign in with Google at `/account`. They edit name, phone, contact email and a favourite delivery point.
- Customers see their carts, export their data, delete the account and sign out of all devices. Telegram linking is not implemented.
- [legal/privacy-notice.uk.md](legal/privacy-notice.uk.md) is a privacy notice template. The operator writes the real text.
- Owners invite staff by Google email. Staff sign in at `/staff`. Roles are owner and manager. Every staff action is audited.
- Owners see a dashboard with cookieless visit statistics, sales and supplier margin, and an infrastructure page.
