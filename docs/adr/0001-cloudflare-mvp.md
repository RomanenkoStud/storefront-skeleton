# ADR-0001: Cloudflare catalog MVP

Status: implementation baseline. Production costs/provisioning are not authorized by this record.

## Context
The owner requests a working catalog MVP with parallel backend/frontend implementation, MyDrop suppliers managed from a cabinet and deployment preparation for Cloudflare. An earlier React/Next product/category/admin prototype is a reference, not a required runtime.

## Options
| Option | Benefit | Cost |
| --- | --- | --- |
| Copy Next/Prisma/Clerk reference | Familiar app skeleton | Extra adaptation and services; carries unrelated ML modules |
| React/Vite + Worker + D1 | One same-origin deploy, SQLite persistence, small runtime | Product SEO needs Worker-generated metadata/detail handling |
| Static-only mock | Fast UI | Cannot satisfy protected persistent manager edits |

## Decision
Implement React/Vite static assets served alongside an ESM Worker, D1 persistence and versioned migrations. Use Cloudflare Access identity: verify RS256 via team JWKS plus issuer, configured audience and required expiration, then audit the verified email. Gate `/admin` and private APIs at the edge and validate again in the Worker. Permit an explicit local bypass only on loopback outside production; do not create a password login. Preserve source snapshots separately from manager overlays. Normalize imported JSON behind a supplier adapter. Use exact MyDrop URL validation and report live-feed failures honestly until an authorized account response is verified; documented endpoint/schema findings are in docs/INTEGRATIONS.md.

## Consequences
Backend and frontend can proceed against shared HTTP contracts in disjoint paths. Public projections isolate supplier costs. Worker SEO needs explicit tests. R2 is optional for uploads; URL-based curated images remain baseline. No running origin, database or paid plan exists until an operator provisions credentials/resources.

## Revisit triggers
Different manager roles, verified MyDrop pagination, inventory exceeding bounded imports, checkout, currencies/taxes, need for durable upload storage, or SEO crawling evidence justify subsequent decisions.

## Authentication reference

The Access check follows the standard Cloudflare Access JWT pattern: read the assertion header or cookie, fetch the team JWKS, then verify the signature. Catalog validation additionally requires exact issuer/audience and an expiration claim; no broad development-mode bypass is allowed.
