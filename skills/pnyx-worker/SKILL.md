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
- Ask a question or for a decision with `pnyx-axi task ask <task> --question "<one short question>" [--context "<a few lines>"] [--choice "<label>[: <description>]"]... [--recommend <n>] [--details-file <path>] --hydra <hydra>`. It goes to Hydra, which answers it or hands it to the owner, and the answer arrives as a message that names the question. Keep working on what does not depend on it and wait for the answer before what does. Choices are optional; evidence goes in `--details` or `--details-file`, not in the question. A worker started without `PNYX_ACTOR` set passes `--actor worker:<task>`.
- Keep each `--note` to one line; a question belongs in `task ask`, not in a status note.
- Declare `blocked` for a real obstacle, `paused` for a deliberate wait, `done` only when the work is finished.
- For code work, finished means landed and verified. Passing tests locally or opening a pull request is not done: stay `working` through review fixes, and declare `needs_you` when the pull request waits on the owner's review or merge. Work with nothing to land, such as an investigation, is done once its checked report is in.
- Your declarations place your card: `working` moves it to In progress, `needs_you` or `blocked` to Needs you, and `done` to Done; `paused` leaves it where it is.
- Silence changes nothing: idling, finishing a turn or exiting never moves the task. Declare a phase change once, not every step.

Send a report that needs no answer with `pnyx-axi hydra send --task <task> --text "<what changed>" --hydra <hydra>`; Hydra reads it as yours, never as the owner's words, and it never answers a question.

Replies reach you as ordinary messages in your session. Link pull requests or tickets with `pnyx-axi link <task> --url <url> --hydra <hydra>`.

Pnyx usually starts you in your task's own copy of the project, on its own branch. Commit your work there and link its pull request: once the task is done, Pnyx removes the copy only if nothing is left uncommitted and the work has landed.

## A queued next task

Keep handling review fixes on your current pull request until it merges. A new message beginning with
another task's worker header is the next assignment: use its task id for every declaration. Pnyx has
fetched the current default branch and switched your clean folder to the new task's branch. Verify the
branch and status before editing; stop and tell Hydra if either differs from the handoff. Leave the
previous branch and its commits intact, and give the next task its own pull request.

## Limits

Work on your task only. Do not create, assign or attach other tasks or workers, and do not move columns; that is Hydra's job. If the task needs splitting, say so with `needs_you`.
