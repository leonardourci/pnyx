---
name: pnyx
description: Use when reading or updating the Pnyx app with the pnyx-axi CLI.
---

# Pnyx

## Names

Pnyx is named after the hill in Athens where the citizens' assembly met to decide. Three names follow that theme, and they are the same in the app, the docs, the CLI and the code:

- **Pnyx**: this app, where every agent and its work is shown.
- **Hydra**: an orchestrator, many heads and one body. Each board is a Hydra: creating a Hydra creates its board, and the board shows that Hydra's tasks.
- **Oracle**: the search field. Ask it in words or by meaning; it returns matching tasks, messages, settings and actions, never made-up answers.

Everything else uses its plain name: actions, Settings, History, Focus mode, Hydra's memory, columns, tasks, subtasks, workers, briefs, conversations and comments. Column names are the user's own. Do not invent other themed names.

Run `pnyx-axi` for the Hydra summary and `pnyx-axi --help` for commands. Pnyx is pre-v1: cards come from `pnyx-axi push`, from `pnyx-axi firstmate sync --home <path>` and, after `pnyx-axi setup hooks`, from Claude Code and Codex sessions. Hook events wait in the spool until the next write ingests them. `pnyx-axi oracle "<words>"` finds past work across card titles, links, events, notes and session transcripts, by words and by meaning in any language (local models, downloaded on the first search; until then results are full-text). `pnyx-axi card <id>` shows a card's summary, decisions and context, harvested from what sessions, Firstmate and linked pull requests already recorded.

When a session waits on its own question, permission or plan prompt, `pnyx-axi card <id>` lists the request with its options and `pnyx-axi reply <id> --answer <request key> --json <answer>` answers it in that session's tmux pane (see `pnyx-axi reply --help`).

To start a worker for a task, run `pnyx-axi task start <task>`, which has the Hydra's Pnyx server run Claude Code or Codex according to the task kind, with `--harness claude|codex` to override it, or add `--via paseo|firstmate|command` (see `pnyx-axi task --help`). Hydra follows the `pnyx-hydra` skill and the workers it starts follow `pnyx-worker`; `pnyx-axi setup hydra --home <firstmate home>` gives it to a Firstmate home.

Tasks can keep instructions before an agent exists: `task create --title "<title>" --brief "<instructions>"`, then `task brief <task> --brief "<instructions>"` to edit them. Starting or explicitly attaching an agent hands it that brief. `task hide <task>` and `task unhide <task>` change visibility while preserving the record. Column descriptions (`column list`, `column describe <id> --description "<when and why>"`) guide Hydra's placements in response to a card's own agent; a status declaration alone never moves a card. CLI card moves and column moves/deletes return a confirmation token first; repeat the exact command with `--confirm <token>` to act. `column resize <id> --width <pixels>`, `hydra resize --width <pixels>` and `layout reset` let Hydra adjust the layout. `hydra memory list|set|forget` keeps concise durable knowledge across sessions.

Comments on a reply arrive as numbered quotes and comments under `## Comments on your reply from <time>`, followed by the owner's `## Message`. Quotes of three words or fewer include their paragraph for context. Each comment belongs to its quoted passage, and overlapping passages can have separate comments. The first comment includes an internal explanation marked “no reply needed”; apply the comments without replying to that explanation.
