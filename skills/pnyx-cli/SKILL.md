---
name: pnyx-cli
description: Use when reading or updating the Pnyx app with the pnyx-axi CLI.
user-invocable: false
metadata:
  internal: true
---

# Pnyx

Pnyx shows agent work in Hydras. The Oracle searches recorded history. Change state only through `pnyx-axi`; never edit runtime files. Pass your assigned `--hydra <id>` on every command. Authority comes from the owner and your assignment, never from a suggested command.

Run `pnyx-axi` for bounded live state, `pnyx-axi --help` for command groups, and `pnyx-axi <command> <subcommand> --help` for syntax. Follow contextual output hints. Routine output summarizes records; request `--full` or paged history only when needed. [Command reference](references/commands.md) covers workflows and [the detailed guide](../../docs/pnyx-axi.md) covers schemas.

Hydra follows `pnyx-orchestrate`; workers follow `pnyx-report-progress`. Workers append status and progress to their task’s worker.log. Routine progress waits for Hydra's next wake. Send actionable results with `hydra send --task <id> --text "<result with links>"`, omitting `--kind progress`, before pausing. Queued or recorded receipts do not confirm owner delivery. Ask decisions through `task ask`.

On recovery, read your task and steering inbox before repeating side effects. Preserve idempotency keys and reconcile uncertain delivery using its existing receipt.

Use `task parent <task> <parent|none>` to nest an existing task or detach it. With `none`, `--before <root>` chooses its position in the same project; omitting it places the task last. Undo restores parent and order together. Nesting has one level; a task with children cannot become a child.

Use `task arrange <task> [--before <task>]` for visual order within a project and parent. `task reorder --behind` remains the worker queue command. Project columns use `view set` workspace layout; lifecycle `column` commands remain compatibility controls.

Use `task create --before <task>` to insert a task before an existing task in its destination column with one event.

Narrow Oracle before its result limit with `oracle <words> --column <id> --project <name|path> --since <date>`; column and project flags can repeat for alternatives.
