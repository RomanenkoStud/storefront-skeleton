---
name: tick
description: Run one orchestrator tick — absorb lead answers, integrate finished agents, sync the Beads board, dispatch the next confident work in parallel, report, and schedule the next wakeup. Use with `/loop /tick` in a session started as `claude --agent orchestrator`.
---

Run exactly one tick of the procedure in `.claude/agents/orchestrator.md`, "Dispatch cycle". It must be idempotent: if a previous tick was interrupted, reconcile `running.json` with reality (`git worktree list`, `bd list --status in_progress --json`, agent notifications) before dispatching anything new.

If `docs-local/orchestrator/` doesn't exist, create it first with `state.json` set to `{"mode":"attended","maxParallel":3,"autoMerge":false,"autoPush":false,"limitedUntil":null,"lastDigest":null}`, plus an empty `inbox.md`, `running.json` (`[]`) and `log/`.

Finish with the attended or away report, then call ScheduleWakeup using the pacing rules (pass the same `/tick` prompt back). Set `noop: true` when nothing changed.
