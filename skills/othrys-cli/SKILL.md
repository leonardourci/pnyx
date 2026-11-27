---
name: othrys-cli
description: Use the plain Othrys CLI for immediate actions and read Titan and task records from files.
user-invocable: false
metadata:
  internal: true
---

# Othrys

Use `othrys --help` for syntax. Pass your assigned `--titan <id>` on actions.

- `othrys task create --title "<work>" --brief "<instructions>"` saves a task and starts its worker. With neither `--project` nor `--folder`, the worker starts in its own scratch folder. `othrys task project <task> --project <name|path>` attaches a project and asks a scratch worker to continue there. A plain folder works as a project.
- `othrys send --text "<message>"` sends to Titan. Add `--task <id>` to address a worker. Give `--file <path|->` instead of `--text` to read a message from a file.
- `othrys answer <task> <question> --text "<answer>"` answers a saved question. Titan relaying an owner decision identifies its source with `--from-message <id>`.
- `othrys task ack <task> <instruction-id> --session <session> --generation '<native-reference>'` records that the assigned worker read that exact instruction. Copy the assignment arguments from its notice or native record; acknowledgement is neither completion nor permission approval.
- `othrys titan` shows the current Titan. Add `--json` when a script reads a receipt.

Read `$OTHRYS_HOME/titans/<titan>/titan.log` and `tasks/<task>/task.log` and `worker.log` directly; the default home is `~/.othrys`. The optional `snapshot.json` is a cached view and may be older than the logs. Each native log has its own line numbers; retain file scope and record IDs, and follow recorded transcript paths for full agent replies. Use the UI for configuration and task edits.

Workers report through their assigned `worker.log` using `othrys-report-progress`. A queued receipt is not proof of delivery. Reconcile the saved record before repeating a side effect.
