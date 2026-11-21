# Lorem Store: agent rules

Read docs/PRODUCT.md, docs/ARCHITECTURE.md and docs/WORKFLOW.md before implementation. Read docs/API.md before you change API behavior. Read docs/SETUP.md before you change deploy config or workflows.

## Worktrees and delivery
- Use one task branch and one sibling worktree for each task, including docs and review. Create it with `tools/agent-worktree.sh create <role> <ticket>`.
- Never edit tracked files in the main checkout or in the checkout of another agent. Do not install, build or run apps in main. Do not rename the branch of another agent.
- Before you edit, confirm `pwd`, `git branch --show-current` and `git status --short`. Declare your owned paths. Serialize changes to overlapping files and agree shared contracts first.
- Use the task-local `node_modules`, `.wrangler` state and ports from `.claude/tmp/worktree.env`. Never symlink modules from another checkout.
- Never copy `.dev.vars`, private databases, secrets, local settings, transcripts or other worktrees. Use isolated fixtures for destructive QA.
- A task assignment permits local commits of owned, validated changes. Push and PR creation need the active user or orchestrator authorization.
- Never force-push, amend or rewrite history. Never merge locally, push to `main` or bypass checks. Do not repair a task failure in the main checkout.
- Open the task PR to `staging` first. Promote the same unchanged branch to `main` only after the lead approves the staging test. Never merge `staging` into a task branch.
- Only the orchestrator merges, after independent review and green CI on the current head and base. Releases come only from the staging and production workflows.
## Tracking and authority
- Use Beads (`bd`) for durable tasks. Read `.agents/skills/beads/SKILL.md`. The orchestrator owns the canonical tracker and serializes all writes. Workers report tracker changes in the handoff and never write Beads or initialize a second tracker.
- Do not spend money, provision services or contact other people without existing authority.
## Engineering
- Keep supplier snapshots (CRM/source data) and manager overrides separate. Sync is idempotent and preserves manager edits and tombstones.
- New imports start unpublished. Do not change publication of live inventory without a user instruction. Keep fixtures distinct from live inventory.
- Public responses never contain supplier costs, internal or source IDs, credentials, customer data or draft products.
- Enforce authentication and permission checks on the server for every private read and mutation. Validate text, URLs and uploads.
- Money is integer kopecks in UAH with explicit rounding. The server calculates every price. Never trust a price from the browser.
- Category and brand inference is deterministic, local and reviewable. Test critical sync, pricing and permission behavior.
## Authentication boundaries
- Owners use Cloudflare Access on `/admin`, `/api/admin/*` and `/api/auth/*`. Verify RS256 JWTs with issuer, audience and expiry checks. These routes have no password login and no application session.
- Staff use Google sign-in only on `/staff` and `/api/staff/*`, with separate tables and the `__Host-ls_staff` cookie. Read the staff role from D1 on every request.
- The path prefix decides the accepted credential. Every Access identity is an owner. Manager routes never accept customer sessions.
- Customers use Google OIDC (code and PKCE, server-side) only on `/api/account/*`, with their own cookie and tables. A customer session never grants a staff role. Customer routes ignore Access JWTs and the development bypass.
- The development bypass needs `AUTH_DEV_BYPASS=true`, `APP_ENV=development` and a loopback host. It never authenticates staff or customers. Never widen or re-scope the manager Access application without explicit lead approval.
