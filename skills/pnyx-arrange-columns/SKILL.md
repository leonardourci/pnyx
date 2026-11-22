---
name: pnyx-arrange-columns
description: Use when arranging projects and tasks in the Pnyx UI.
user-invocable: false
metadata:
  internal: true
---

# Arrange the Hydra

Use the UI to attach and arrange projects, nest or order tasks, and resize their columns. Read `pnyx task list --hydra <id> --json` for current placement. The CLI keeps transitional layout and column reads; use the UI for changes.

Running and idle come from sessions; workers append their status and links to worker.log. Completion follows the task's landing rules. Do not edit the snapshot or canonical logs to change placement.
