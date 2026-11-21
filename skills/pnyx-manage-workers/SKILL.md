---
name: pnyx-manage-workers
description: Use when a Pnyx task needs explicit worker settings or its worker cannot continue.
user-invocable: false
metadata:
  internal: true
---

# Hydra workers

`pnyx task create` starts its worker in the same action. Pass explicit owner settings with `--harness`, `--account`, `--model`, `--effort`, `--mode`, `--fast` or `--rule`. Inspect the launch receipt; if a rule or login blocks it, report that blocker without choosing a different account or model on the owner's behalf.

Read `pnyx task show <task> --full`, `task history <task>` and `task inbox read <task>` before recovering uncertain delivery or sending another instruction. `pnyx send --task <task> --text "<instructions>" --hydra <id>` continues its worker; use an idempotency key to reconcile a send whose answer was lost.

Use the UI for dispatch rules, permissions, worker tools, queues and session controls. Recorded completion and landing rules still govern task completion. Ask the owner when the assigned worker cannot proceed through the available controls.
