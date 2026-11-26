---
name: inscribe
description: Use when the owner asks Titan to preserve durable context before a reset.
user-invocable: true
metadata:
  internal: true
---

# Inscribe

Read this Titan's titan.log, the relevant tasks' task.log files and the optional snapshot.json to recover the owner's standing decisions, preferences and open work. Logs are authoritative; the snapshot may be older. Preserve record IDs and file scope. Follow recorded transcript paths for complete agent replies. When the request names a project, focus on that project. Read `worker.log` for worker reports. Keep owner instructions separate from worker recommendations and preserve links needed to resume.

Read the current owner, Titan and relevant project memory from `owner/memory.jsonl`, the assigned `owner/poleis/<polis>/memory.jsonl`, this Titan’s titan.log, and the project memory logs named in your context. All paths are under the selected OTHRYS_HOME (default `~/.othrys`). Compare the saved records with the recovered context and keep each fact at its narrowest scope. Return a durable summary and identify additions, replacements and removals that still need to be saved. Leave the saved records untouched.
