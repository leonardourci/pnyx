---
name: inscribe
description: Use when the owner asks Hydra to preserve durable context before a reset.
user-invocable: true
metadata:
  internal: true
---

# Inscribe

Read `pnyx hydra history --since origin --hydra <id> --json`, its digest and relevant task histories to recover the owner's standing decisions, preferences and open work. Follow the history cursor until you cover the relevant range. When the request names a project, focus on that project. Read `worker.log` for worker reports. Keep owner instructions separate from worker recommendations and preserve links needed to resume.

Keep each fact at its narrowest owner, project or Hydra scope, and remove stale or duplicate text. During the storage cutover, the CLI exposes memory list, digest and history reads; memory writes are not available through the plain CLI. Return the durable context summary and identify any changes that still need to be saved. Do not claim that the summary was saved, and do not edit server-owned records.
