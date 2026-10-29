---
name: pnyx-cli
description: Use when reading or updating the Pnyx app with the pnyx-axi CLI.
user-invocable: false
metadata:
  internal: true
---

# Pnyx

## Names

Pnyx is named after the hill in Athens where the citizens' assembly met to decide. Three names follow that theme, and they are the same in the app, the docs, the CLI and the code:

- **Pnyx**: this app, where every agent and its work is shown.
- **Hydra**: an orchestrator, many heads and one body. Each Hydra has its own columns and tasks, and creating a Hydra creates them.
- **Oracle**: the search field. Search it by keyword; it returns matching tasks, messages, settings and actions, never made-up answers.

Everything else uses its plain name: actions, Settings, History, Focus mode, Hydra's memory, columns, tasks, subtasks, workers, briefs, conversations and comments. Column names are the user's own. Do not invent other themed names.

Run `pnyx-axi` for the Hydra summary and `pnyx-axi --help` for commands. Pnyx is pre-v1: cards come from `pnyx-axi push`, from `pnyx-axi firstmate sync --home <path>` and, after `pnyx-axi setup hooks`, from Claude Code and Codex sessions. Hook events wait in the spool until the next write ingests them. `pnyx-axi oracle "<words>"` finds past work across card titles, links, events, notes and session transcripts by keyword, matching stems, synonyms and near spellings. `pnyx-axi card <id>` shows a card's summary, decisions and context, harvested from what sessions, Firstmate and linked pull requests already recorded.

When a session waits on its own question, permission or plan prompt, `pnyx-axi card <id>` lists the request with its options and `pnyx-axi reply <id> --answer <request key> --json <answer>` answers it in that session's tmux pane (see `pnyx-axi reply --help`).

To start a worker for a task, run `pnyx-axi task start <task>`, which has the Hydra's Pnyx server run Claude Code or Codex according to the task kind, with `--harness claude|codex` to override it, or add `--via paseo|firstmate|command` (see `pnyx-axi task --help`). Hydra follows the `pnyx-orchestrate` skill and the workers it starts follow `pnyx-report-progress`; `pnyx-axi setup hydra --home <firstmate home>` gives it to a Firstmate home.

For related local task changes, prefer one `pnyx-axi apply --file <path|-> --hydra <hydra>` over separate calls. Its versioned JSON document contains `changes` and optional `expected.tasks` revisions; `--check` previews the complete diff without writing. Supported operations are `task.create`, `task.brief`, `task.owner-ask`, `task.depend`, `task.undepend`, `task.status`, `task.hold`, `task.release`, `link` and `outcome`. `intent` on `task.create` or `task.brief` sets the card's goal; `task.owner-ask` keeps the owner's exact words separately. A create's `as` alias can be used later as `$alias`. Keep the document and `--event-id` unchanged on retries. All changes, including lifecycle effects, commit together; invalid input writes nothing. Correct batches with another apply, since undo refuses their child events. Starts, messages, memory and settings stay separate. See [the operation schema](../../docs/pnyx-axi.md#atomic-local-changes).

Tasks can keep instructions before an agent exists: `task create --title "<title>" --brief "<instructions>"`, then `task brief <task> --brief "<instructions>"` to edit them. Starting or explicitly attaching an agent hands it that brief. `task hide <task>` and `task unhide <task>` change visibility while preserving the record. Task and agent operations record their lifecycle facts and place cards with worker declarations. Column descriptions (`column list`, `column describe <id> --description "<when and why>"`) guide manual moves, reserved for owner requests or exceptional corrections with a reason. CLI card moves and column moves/deletes return a confirmation token first; repeat the exact command with `--confirm <token>` to act. `column resize <id> --width <pixels>`, `hydra resize --width <pixels>` and `layout reset` let Hydra adjust the layout. `owner memory list|set|forget|move` keeps the owner's preferences and learnings for every Hydra, and `hydra memory list|set|forget` what only one Hydra needs.

Comments on a reply arrive as numbered quotes and comments under `## Comments on your reply from <time>`, followed by the owner's `## Message`. Quotes of three words or fewer include their paragraph for context. Each comment belongs to its quoted passage, and overlapping passages can have separate comments. The first comment includes an internal explanation marked “no reply needed”; apply the comments without replying to that explanation.
