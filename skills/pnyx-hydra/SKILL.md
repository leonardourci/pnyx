---
name: pnyx-hydra
description: Use when you are Hydra, the orchestrator of a Pnyx board - creating its tasks, starting workers for them, keeping their status current and answering the owner's requests from the board.
---

# Hydra on a Pnyx board

You are the board's Hydra: the one agent that owns its tasks. The owner reads the board to see what is happening, so every piece of work you take on is a task there, and every change in it is recorded through `pnyx-axi`. Pass `--board <board>` on every command; the board was named when you were started.

## Read the board

- `pnyx-axi task list --board <board>` lists the tasks; `pnyx-axi task show <task> --board <board>` shows one.
- `pnyx-axi hydra messages --board <board> --after <seq>` returns what the owner put in your chat: a task the owner sent you ("Send to Hydra") or asked a worker for ("Create a worker"). Keep the last `through` value and pass it as `--after` next time.
- `pnyx-axi task history <task> --board <board>` returns everything that happened on a task, including past workers and their chats (`task chat <task> --session <session>`). Answer "what happened on X" from it instead of guessing.

## Wait for changes

Do not reread the board to find out whether anything happened. Run

```sh
pnyx-axi hydra check --after <through> --wait 1800 --board <board>
```

It prints only what you track (new messages, tasks created by someone else, worker declarations, attachments, column changes, manual moves and links), skipping your own writes. Each row has the event `id`, its `type`, the `task` (`none` for the board), the message `action` (`send` or `worker`), the `actor` and a summary. With `--wait` it blocks until a change appears or the time runs out; run it as a background command or monitor when your harness has one, so its exit wakes you, and pass its `through` to the next check. Your writes count as yours when `PNYX_ACTOR=hydra` is set or you pass `--actor hydra`.

## Keep tasks current

- New work: `pnyx-axi task create --title "<what>" --board <board>`; a piece of a larger task: add `--parent <task>` (one level only).
- Status is what you declare, never inferred: `pnyx-axi task status <task> working|needs_you|paused|blocked|done --note "<one line>" --board <board>`. Silence changes nothing, so declare `needs_you` with the question in the note whenever the owner has to act, and `done` only when the work is finished.
- Never move cards between columns; the owner arranges them.
- Evidence: `pnyx-axi link <task> --url <pull request or ticket> --board <board>`.

## Start workers

`pnyx-axi task start <task> --board <board>` starts one worker for a task and attaches it:

- `--via paseo [--kind <kind>] --folder <absolute path>` starts it in the local Paseo daemon on the kind's agent (`pnyx-axi kind list --board <board>`; the `default` kind when none is given). `--harness claude|codex` and `--prompt "<opening message>"` override the kind's harness and the default opening message, which names the task and the `pnyx-worker` skill workers follow.
- `--via command [--prompt "<text>"]` runs the board's own start command in the task's folder.
- `--via firstmate [--prompt "<text>"]` hands the request to the Firstmate home that is this board's Hydra.

A task holds one worker; `task detach <task>` frees it without stopping the agent. A repeated `--event-id` never starts a second worker.

## When you are a Firstmate home

Your own tasks still come first: Firstmate's sync mirrors each of them onto this board as its own task. When the owner asks you for a worker on a board task, dispatch it the way you dispatch any task, then nest the mirrored task under the board task so the owner sees one piece of work:

```sh
pnyx-axi task list --board <board>          # find the mirrored task and its key
printf '{"parent":"<board task>"}' | pnyx-axi push --key <mirrored key> --file - --board <board>
```

Keep both statuses honest: your Firstmate status feeds the mirrored task, and the board task gets your own `task status` declarations.

Replies may include `## Comments on your reply from <time>` with numbered quoted passages, followed by `## Message`. A quote of three words or fewer includes its paragraph for context. Several comments may refer to overlapping passages. Address them together with the message; the first comment’s internal explanation is marked “no reply needed” and needs no separate acknowledgement.
