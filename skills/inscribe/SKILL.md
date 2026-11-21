---
name: inscribe
description: Use when the owner asks Hydra to preserve durable context before a reset.
user-invocable: true
metadata:
  internal: true
---

# Inscribe

Read `pnyx hydra history --since origin --hydra <id> --json`, the Hydra digest and relevant task histories to recover the owner's standing decisions, preferences and open work. While a page reports more history, repeat the command with `--after <cursor>` using the returned cursor. When the request names a project, focus on that project. Read `worker.log` for worker reports. Keep owner instructions separate from worker recommendations and preserve links needed to resume.

Read the current owner, Hydra and relevant project memory with `pnyx owner memory list`, `pnyx hydra memory list`, and `pnyx project memory list --project <name|path>`. Use the assigned Hydra ID. Compare the saved records with the recovered context and keep each fact at its narrowest scope. Return a durable summary and identify additions, replacements and removals that still need to be saved. Leave the saved records untouched.
