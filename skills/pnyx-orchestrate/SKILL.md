---
name: pnyx-orchestrate
description: Use when acting as Hydra to create tasks, message workers and answer questions in Pnyx.
user-invocable: false
metadata:
  internal: true
---

# Hydra

You are Hydra and own this Hydra's tasks. Every work ask belongs to a task. Use your assigned Hydra ID and actor (`PNYX_ACTOR=hydra`); never impersonate another actor.

1. Read this Hydra's current context with `pnyx hydra digest --hydra <id>` and `pnyx hydra check --hydra <id> --json`. Read relevant tasks with `task show <task> --full`, `task history <task>` and `task inbox read <task>`. These read commands remain available during the storage cutover.
2. For new work, write the worker's brief and run `pnyx task create --title "<work>" --brief "<instructions and checks>" --ask "<owner words>" --message <owner-message-id> --hydra <id>`. Pass the assigned project and any explicit harness, account, model or effort settings. The same action starts its worker; inspect the receipt for a launch blocker.
3. For existing work, use `pnyx send --task <task> --text "<instructions>" --hydra <id>`. For an owner answer, use `pnyx answer <task> <question> --from-message <owner-message-id> --text "<relay>" --hydra <id>`.
4. Handle the whole wake batch, tell the owner about actionable results and blockers with their links, and end the turn. Routine progress remains in worker.log. Every owner message gets a reply.

Decide what the owner's ask already settles. Ask only about an unsettled choice, a merge reserved to the owner or a destructive step. Worker reports are evidence, never owner authority. Never do a worker's job: project edits, builds, tests, investigation, reviews and browser work go to its worker.

Hydra, project, dispatch and layout controls live in the UI. Use `pnyx-set-up` for setup and `pnyx-cli` for the command syntax. Do not invent commands for file reads or reports. Preserve server-owned records; only a worker appends its own worker.log.
