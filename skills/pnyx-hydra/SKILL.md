---
name: pnyx-hydra
description: Use when you are the Hydra (orchestrator) of a Pnyx board and are not Firstmate - reading Hydra's queue, creating and assigning tasks and subtasks, launching workers and tracking them with pnyx-axi.
---

# Pnyx Hydra

You orchestrate one Pnyx board. The board is the record: every task, subtask, worker, request and declaration is an event in its log, so anyone can later ask what happened in a task and get the answer from `pnyx-axi task history`. You assign work; workers do it. Firstmate never loads this skill; it runs a board with its own mechanics.

Every command takes `--board <board>`; pass it on each call (it defaults to `default`). Writes made with `PNYX_ACTOR=hydra` in the environment (set when `pnyx-axi hydra start` launched you) are yours; otherwise add `--actor hydra` to each write so your own changes never wake you.

## Start

1. Bind yourself, once: `pnyx-axi board set --session self --board <board>` (or `--session <id>` from `pnyx-axi task sessions`).
2. Read the state: `pnyx-axi hydra messages --board <board>` (keep its `through`), `pnyx-axi task list --board <board>` and `pnyx-axi kind list --board <board>`.

## Light check

Do not reload the board to find out whether anything happened. Run

```sh
pnyx-axi hydra check --after <through> --wait 1800 --board <board>
```

It prints only what you track (new messages, tasks created by someone else, worker declarations, attachments, column changes, manual moves, links, launches) and skips your own writes. Each row has the event `id`, its `type`, the `task` (`none` for the board), the message `action` (`send` or `worker`), the `actor` and a summary. With `--wait` it blocks until one appears or the time runs out; run it as a background command or monitor when your harness has one, so its exit wakes you. Pass its `through` to the next check. When it says `none`, nothing needs you.

## Handle what changed

- **A board message** (`task: none`): the user is talking to you. Plan the work and create tasks for it; answer in your own conversation.
- **Send to Hydra** (`action: send` with a task): the user wants to talk about that task. Read `pnyx-axi task show <id>` and `pnyx-axi task history <id>` and continue the conversation about it.
- **Create a worker** (`action: worker` with a task): launch one (below), passing `--request <message id>`.
- **A declaration** from a worker: `needs_you` or `blocked` means it is waiting; answer it with `pnyx-axi reply <task> --text <text>` when you can, or leave the task in Needs you for the user. `done` closes the work; check the result, then pick up what it unblocks.
- **A task or column the user created or moved**: it is context, not a command. Ask or plan, but never undo the user's edits.

## Tasks

- Create: `pnyx-axi task create --title <title> [--column <id>] [--folder <dir>]`. A task in no particular column starts parked; a task can stay parked with no worker.
- Subtasks: `pnyx-axi task create --title <title> --parent <task>`; only one level. Dispatch as many as the task needs and give each its own worker.
- Rename with `task rename`. Columns are the user's; use `column` commands only when asked.
- Record your own decisions on a task with `pnyx-axi task status <id> <state> --note <text>` only when the state really changed; silence never moves a task.

## Workers

```sh
pnyx-axi worker create <task> [--kind <kind>] [--cwd <dir>] [--request <message id>] [--text "<instructions>"]
```

This opens a Paseo terminal in `--cwd`, else the task's folder, else yours, starts the kind's agent with a first prompt that names the task, and records `worker.launched`. The agent's first session in that terminal joins the task. Pick the kind from `pnyx-axi kind list`; `default` is used when none fits. `--preview` prints the command line instead, for a terminal Pnyx cannot open.

One task has at most one worker. To hand a task to someone else, `pnyx-axi task detach <task>` first; the previous worker stays in the task's history, and `pnyx-axi task chat <task> --session <session>` reads any past worker's conversation.

## Answering "what happened in X"

`pnyx-axi task history <task> [--full]` lists the task's and its subtasks' events and every session that worked on it, and `pnyx-axi search "<words>" --board <board>` finds older work across titles, events, notes and transcripts. Read those before answering; never guess.

## Limits

You do not supervise processes: Pnyx never stops, restarts or polls an agent. A worker that goes quiet stays where it is; ask it with `pnyx-axi reply` if you need to know.
