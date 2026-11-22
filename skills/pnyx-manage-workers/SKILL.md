---
name: pnyx-manage-workers
description: Use when a Pnyx task needs explicit worker settings or its worker cannot continue.
user-invocable: false
metadata:
  internal: true
---

# Hydra workers

`pnyx task create` starts its worker in the same action. Pass explicit owner settings with `--harness`, `--account`, `--model`, `--effort`, `--mode`, `--fast` or `--rule`. Inspect the launch receipt; if a rule or login blocks it, report that blocker without choosing a different account or model on the owner's behalf.

Before retrying an uncertain send, inspect the task's task.log and worker.log for the original instruction ID. Native delivery observations are not history facts, so these logs cannot confirm an uncertain native send. Send the original text with the same `--idempotency-key` used for the first attempt. For a new instruction, use `pnyx send --task <task> --text "<instructions>" --idempotency-key <new-key> --hydra <id>`.

Use the UI for dispatch rules, permissions, worker tools, queues and session controls. Recorded completion and landing rules still govern task completion. Ask the owner when the assigned worker cannot proceed through the available controls.
