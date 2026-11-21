# Agent delivery workflow

Each task runs on its own branch in its own sibling worktree. The main checkout is the integration reference. It is never an agent workspace.

| Role | Responsibility |
| --- | --- |
| orchestrator | Dispatch, the only Beads writer, review gates, PR integration |
| project-manager | Backlog structure, only while it holds the orchestrator's writer slot |
| architect | Interfaces, data ownership and ADRs on a task branch |
| backend / frontend / implementer | Scoped implementation and local checks |
| reviewer | Read-only diff review and independent checks in a review worktree |
| qa | Tests in isolated storage; reports observed results |

## Dispatch
1. The orchestrator gives each task a Beads issue, acceptance criteria, owned paths, a base revision and test resources.
2. Agree API and data contracts first. Order overlapping work explicitly: shared files, migrations, taxonomy, manifests, lockfiles and workflows.
3. Run `git fetch origin main` when remote access is authorized. Record the base SHA in the handoff.
4. Create the checkout from any clean checkout: `tools/agent-worktree.sh create <role> <ticket> [worker-port]`. Use `tools/agent-worktree.sh list` to see existing ones.

The helper creates branch `task/<role>-<ticket>` in the sibling directory `../<repository>-worktrees/<role>-<ticket>`. It starts from `origin/main`, or from local `main` if no remote ref exists. It refuses dirty checkouts and existing paths or branches. It reserves three ports and writes them to `.claude/tmp/worktree.env`. It never copies secrets, `.dev.vars`, databases or modules. It never fetches, installs, commits, pushes or deletes. It is a dispatch guard, not a security sandbox.

## Local runtime
```bash
source .claude/tmp/worktree.env
npm ci && npm run check && npm test && npm run build
npx wrangler d1 migrations apply DB --local --persist-to "$WRANGLER_PERSIST_TO"
npx wrangler dev --ip 127.0.0.1 --port "$WORKER_PORT" --inspector-port "$INSPECTOR_PORT" --persist-to "$WRANGLER_PERSIST_TO"
npm run dev:web -- --port "$VITE_PORT" --strictPort
```
- The Vite proxy targets port 8787. Point it and browser tests at your own `$WORKER_PORT`. Never use the server of another task.
- Keep runtime data and temporary files on disk in the task checkout, not in RAM-backed `/tmp`.
- Check memory before heavy build or browser jobs. Stop every server that you start.
- Use fixtures and the loopback development bypass. Never point destructive tests at real inventory or production D1.

## Commit, PR and release
1. Commit only owned paths, after the relevant checks pass.
2. Push and open a PR against `staging` only under active authorization. Never open the first PR against `main`.
3. A reviewer checks the PR diff, ownership, contracts, security and acceptance criteria. Fixes stay on the task branch.
4. CI must pass on the latest PR head and current base. An earlier green run does not count after a change.
5. To integrate a newer `main`, merge `main` into the task branch with orchestrator authorization. Rerun checks. Never rebase shared history. Never merge `staging` into a task branch. Resolve a conflict with staging-only work on an integration branch cut from `staging`.
6. The orchestrator merges through GitHub with a merge commit. Merging into `staging` deploys staging (`staging.yml`). Confirm that run.
7. The lead tests on the staging host (for example https://staging.example.com). A feature can stay on staging indefinitely. The lead decides promotion.
8. After lead approval, open a second PR from the same unchanged branch into `main`. The CI job `Require feature tested on staging` checks that head.
9. Any new commit on the branch, including a `main` merge, goes through `staging` again. Keep the branch until promotion; automatic head-branch deletion stays off.
10. A merge into `main` runs the production deploy in `ci.yml`, which repeats the staging check. Confirm the run and the deployed version. Close the Beads issue only after the `main` merge. Record both PRs and the observed checks.

Some GitHub plans give no branch protection on private repositories. If branch protection is not active, the orchestrator enforces the review and CI gate manually. Never claim that branch protection is active when it is not.

## Handoff and cleanup
Report the task ID, branch, checkout, base and head SHA, PR and changed files. Also report the review result, observed checks, stopped servers and unverified integrations. A fixture test does not prove a live supplier feed. Worktree deletion, branch deletion and secret provisioning need separate explicit authorization. Keep failed tasks in their worktree for inspection.
