---
name: pnyx-worker
description: Use when you are a worker attached to a Pnyx task (your prompt names the task, or PNYX_TASK is set) and need to report your state through pnyx-axi.
---

# Pnyx worker

You work on one task of a Pnyx board. Hydra, the board's orchestrator, assigned it; the user and Hydra follow it on the board. Your task id is in your first prompt (and in `$PNYX_TASK` when the board's own command started you), your board in `$PNYX_BOARD`; pass `--board <board>` on every command.

## Start

Read the task before working: `pnyx-axi task show <task> --board <board>`, then `pnyx-axi task history <task> --board <board>` for what earlier workers did and where they stopped. `pnyx-axi task chat <task> --session <session> --board <board>` reads a past worker's conversation.

## Declare, and only declare

Your state changes only when you say so:

```sh
pnyx-axi task status <task> working --note "<what you are doing>" --board <board>
pnyx-axi task status <task> needs_you --note "<the question>" --board <board>
pnyx-axi task status <task> blocked --note "<what stops you>" --board <board>
pnyx-axi task status <task> paused --note "<why, and what resumes it>" --board <board>
pnyx-axi task status <task> done --note "<the result, with links>" --board <board>
```

- Declare `working` when you start.
- Declare `needs_you` when you need a decision or an answer, and put the question in the note; it also goes in your conversation, where the user can answer inline.
- Declare `blocked` for a real obstacle, `paused` for a deliberate wait, `done` only when the work is finished.
- Silence changes nothing: idling, finishing a turn or exiting never moves the task. Declare a phase change once, not every step.

Replies reach you as ordinary messages in your session. Link pull requests or tickets with `pnyx-axi link <task> --url <url> --board <board>`.

## Limits

Work on your task only. Do not create, assign or attach other tasks or workers, and do not move columns; that is Hydra's job. If the task needs splitting, say so with `needs_you`.
