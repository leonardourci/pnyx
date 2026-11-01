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

Hydra follows `pnyx-orchestrate`; workers follow `pnyx-report-progress`. Lifecycle declarations describe work. Routine progress waits for Hydra's next wake. Send actionable results with `hydra send --task <id> --text "<result with links>"`, omitting `--kind progress`, before pausing. Queued or recorded receipts do not confirm owner delivery. Ask decisions through `task ask`.

On recovery, read your task and steering inbox before repeating side effects. Preserve idempotency keys and reconcile uncertain delivery using its existing receipt. Read `native status` for host recovery blockers; only the owner stops the host for maintenance. Re-enter secrets only after Pnyx confirms the original attempt was never received.
