# Lorem Store

Read AGENTS.md first. It links the product, architecture and workflow docs.

- Profiles: orchestrator, project-manager, architect, backend, frontend, implementer, reviewer, qa.
- Start the orchestrator from this directory: `claude --agent orchestrator --settings tools/orchestrator-settings.json`.
- `/tick` runs one delivery cycle. `/away` and `/back` change presence only. They give no commit, merge, push or notification authority.
- Give each agent its own task branch and worktree (`tools/agent-worktree.sh`, docs/WORKFLOW.md). Never dispatch workers into the main checkout.
- A worktree does not give permission to publish or merge.
