# Architecture decisions

Each record has context, options, decision, consequences and revisit triggers. The status column shows the state of the current code. It can differ from the status line inside an older record.

| ADR | Title | Status | Decision |
| --- | --- | --- | --- |
| [0001](0001-cloudflare-mvp.md) | Cloudflare catalog MVP | Accepted | One Worker serves the React/Vite assets and the API, with D1, versioned migrations and Cloudflare Access for staff. |
| [0002](0002-task-tracking.md) | Durable work tracking | Accepted | Beads (`bd`) is the only task and kanban source of truth. |
| [0003](0003-client-accounts.md) | Client accounts, sessions and customer data | Accepted | Customers sign in with Google OIDC (code + PKCE) in the Worker. Customer sessions are separate from staff. |
| [0004](0004-telegram-account-linking.md) | Telegram account linking | Not implemented | Telegram links to an existing account only. The schema allows a `telegram` identity, but no link flow exists. |
| [0005](0005-staging-environment.md) | Staging environment | Accepted | A separate staging Worker, D1 and R2 at `staging.example.com`, with no cron. Production data stays out, except a small approved set of sample product rows. |
| [0006](0006-staff-roles-and-staff-google-sign-in.md) | Staff roles and staff Google sign-in | Accepted | Staff roles `owner` and `manager` with permissions, and a staff Google sign-in separate from customers. |
| [0007](0007-customer-cart-checkout.md) | Customer cart and cart-code checkout | Accepted | A server cart and a cart-code checkout with no online payment provider. ADR-0011 amends the checkout body. |
| [0008](0008-picture-normalization.md) | Product picture normalization | Accepted | Fit a saved cutout to a category template in the browser. Only the mask fit is built. The fitter model is not. |
| [0009](0009-webgl-spray-intro.md) | WebGL graffiti landing intro | Superseded by 0014 | A three.js spray intro on the landing page. It is not in the current code. |
| [0011](0011-nova-post-delivery-point.md) | Nova Post delivery-point picker | Accepted | Pick a branch or postomat from our own R2 copy of the Nova Poshta list, synced daily without a key. |
| [0012](0012-merged-duplicate-listing.md) | Merged listing for duplicate groups | Accepted | A confirmed duplicate group shows as one product. Stock is summed. Checkout splits the order by lowest cost. |
| [0014](0014-fresh-drop-hero-and-brand-slots.md) | Fresh-drop hero and brand slots | Accepted | The hero shows the three newest in-stock products. It replaces the WebGL intro and the wall photo. |
| [0015](0015-campaign-band-scenes-and-picture-library.md) | Campaign band scenes and picture library | Accepted | Code-defined band scenes chosen in Вітрина, and a staff-managed category picture library (`campaign_pictures`). |

Numbers 0010 and 0013 are not used.

Related documents: [INTEGRATIONS.md](../INTEGRATIONS.md) for suppliers and the Nova Poshta sync, [MEDIA.md](../MEDIA.md) for photos and thumbnails.
