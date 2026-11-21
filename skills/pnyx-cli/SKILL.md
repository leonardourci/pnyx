---
name: pnyx-cli
description: Use the plain Pnyx CLI for immediate actions and current Hydra and task reads.
user-invocable: false
metadata:
  internal: true
---

# Pnyx

Use `pnyx --help` for syntax. Pass your assigned `--hydra <id>` on actions.

- `pnyx task create --title "<work>" --brief "<instructions>"` saves a task and starts its worker. Pass an assigned project and explicit worker settings as flags.
- `pnyx send --text "<message>"` sends to Hydra. Add `--task <id>` to address a worker. Give `--file <path|->` instead of `--text` to read a message from a file.
- `pnyx answer <task> <question> --text "<answer>"` answers a saved question. Hydra relaying an owner decision identifies its source with `--from-message <id>`.
- `pnyx board` shows the current Hydra. Add `--json` when a script reads a receipt.

During the storage cutover, use `pnyx task list`, `task show <task> --full`, `task history <task>`, `hydra check`, `hydra digest`, `hydra messages` and `task inbox read <task>` for the records the current app serves. Read-only project, memory, dispatch and Oracle commands remain available. Use `--json` for structured reads; output has no next-step hints. Use the UI for configuration and task edits.

Workers report through their assigned `worker.log` using `pnyx-report-progress`. A queued receipt is not proof of delivery. Reconcile the saved record before repeating a side effect.
