---
name: away
description: Lead is stepping away — switch the orchestrator to away mode (no blocking, push-notify only for real blockers). Optional arg is when the lead expects to be back.
---

Set `"mode": "away"` in `docs-local/orchestrator/state.json` (and `"backAt"` if an argument was given). Log it. Reply with one line: what's running, what will continue, and which inbox questions are still open. Then continue the loop.
