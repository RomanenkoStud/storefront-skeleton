---
name: back
description: Lead is back — switch the orchestrator to attended mode and show a catch-up digest plus the open questions that need decisions.
---

1. Set `"mode": "attended"` in `docs-local/orchestrator/state.json`.
2. Show a catch-up since the lead left: merged commits (`git log --oneline` since then), closed beads, what's in flight, and anything that failed.
3. List the open inbox questions as a numbered list, each with the recommendation and what it blocks, so the lead can answer like "Q3: B, Q4: yes".
4. Keep it under 25 lines. Then run a normal tick.
