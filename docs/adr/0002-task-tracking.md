# ADR-0002: Durable work tracking

Status: existing repository convention.

Use Beads (`bd`) as the sole durable task/kanban source of truth. The orchestrator writes status; the project manager maintains structure and criteria; implementers report work and discoveries. Terminal board: `python3 tools/kanban.py`. Local Dolt stores issues; Git remote and Dolt remote synchronization remain unconfigured. Do not use copied Spark issue IDs or duplicate markdown backlogs.

Changes remain uncommitted unless explicitly authorized. A local verified implementation may be marked closed with evidence even when no commit/merge is authorized; report that state in the handoff. Live services and deployment must not be marked verified from fixture tests.
