---
name: pnyx-cli
description: Use the plain Pnyx CLI for immediate actions and read Hydra and task records from files.
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

Read `$PNYX_HOME/hydras/<hydra>/hydra.log` and `tasks/<task>/task.log` and `worker.log` directly; the default home is `~/.pnyx`. The optional `snapshot.json` is a cached view and may be older than the logs. Each native log has its own line numbers; retain file scope and record IDs, and follow recorded transcript paths for full agent replies. Use the UI for configuration and task edits.

`hydra check` returns `epoch` and `through`. Continue with `--after <through> --epoch <epoch>`; a nonzero cursor without the current epoch expires. After restart, read without `--after` for fresh state.

Workers report through their assigned `worker.log` using `pnyx-report-progress`. A queued receipt is not proof of delivery. Reconcile the saved record before repeating a side effect.
