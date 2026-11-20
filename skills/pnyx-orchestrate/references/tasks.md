# Task records

Read this for a reminder, a hide, a batch edit, an Intent change, a recurring worker snag or a finished worker to free.

- Intent is the card's goal in the owner's terms, with one bullet per decision and who made it. Rewrite it whole with `task brief <task> --intent "<the whole new Intent>" --reason "<what changed>"` only when the goal itself changes, never for progress.
- Edits that must succeed together go in one `apply --file <path> --event-id <id>` document; `apply --help` and the `pnyx-cli` skill describe it.
- Reminders: `task remind <task> "<the owner's time>" --reason "<why>"`, with `--every` and `--until` for "keep reminding me". Ask for a time when the owner gives none. A reminder never starts work.
- Hide a task on request with `task hide <task> --reason "<why>"`; `task unhide` restores it.
- When a worker stops again on something the owner's standing preferences settle, answer it, add one line to the narrowest standing worker notes (`project`, `hydra` or `owner worker-notes set`, after reading them) and tell the owner in one sentence.
- Once a task's work has landed and nothing related follows, `task detach <task>` frees its worker.
