---
name: pnyx-worker
description: Use when you are a worker attached to a Pnyx task (your prompt names the task, or PNYX_TASK is set) and need to report your state through pnyx-axi.
---

# Pnyx worker

You work on one task of a Pnyx Hydra. Hydra, the Hydra's orchestrator, assigned it; the user and Hydra follow it on the Hydra. Your task id is in your first prompt (and in `$PNYX_TASK` when the Hydra's own command started you), your Hydra in `$PNYX_HYDRA`; pass `--hydra <hydra>` on every command.

## Start

Read the task before working: `pnyx-axi task show <task> --hydra <hydra>`, then `pnyx-axi task history <task> --hydra <hydra>` for what earlier workers did and where they stopped. `pnyx-axi task chat <task> --session <session> --hydra <hydra>` reads a past worker's conversation.

## Declare, and only declare

Your state changes only when you say so:

```sh
pnyx-axi task status <task> working --note "<what you are doing>" --hydra <hydra>
pnyx-axi task status <task> needs_you --note "<the question>" --hydra <hydra>
pnyx-axi task status <task> blocked --note "<what stops you>" --hydra <hydra>
pnyx-axi task status <task> paused --note "<why, and what resumes it>" --hydra <hydra>
pnyx-axi task status <task> done --note "<the result, with links>" --hydra <hydra>
```

- Declare `working` when you start.
- Declare `needs_you` when you need a decision or an answer, and put the question in the note; it also goes in your conversation, where the user can answer inline.
- Declare `blocked` for a real obstacle, `paused` for a deliberate wait, `done` only when the work is finished.
- Silence changes nothing: idling, finishing a turn or exiting never moves the task. Declare a phase change once, not every step.

To escalate a question or decision to Hydra, use `pnyx-axi hydra send --task <task> --text "<what you need and why>" --hydra <hydra>`. Hydra receives it through the light check and decides whether to answer, update the brief or ask the owner.

Replies reach you as ordinary messages in your session. Link pull requests or tickets with `pnyx-axi link <task> --url <url> --hydra <hydra>`.

Pnyx usually starts you in your task's own copy of the project, on its own branch. Commit your work there and link its pull request: once the task is done, Pnyx removes the copy only if nothing is left uncommitted and the work has landed.

## Limits

Work on your task only. Do not create, assign or attach other tasks or workers, and do not move columns; that is Hydra's job. If the task needs splitting, say so with `needs_you`.
