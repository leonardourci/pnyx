---
name: pnyx
description: Use when reading or updating the Pnyx agent board with the pnyx-axi CLI.
---

# Pnyx

Run `pnyx-axi` for the board summary and `pnyx-axi --help` for commands. Pnyx is pre-v1: cards come from `pnyx-axi push`, from `pnyx-axi firstmate sync --home <path>` and, after `pnyx-axi setup hooks`, from Claude Code and Codex sessions. Hook events wait in the spool until the next write ingests them. `pnyx-axi search "<words>"` finds past work across card titles, links, events, notes and session transcripts, by words and by meaning in any language (local models, downloaded on the first search; until then results are full-text). `pnyx-axi card <id>` shows a card's summary, decisions and context, harvested from what sessions, Firstmate and linked pull requests already recorded.

When a session waits on its own question, permission or plan prompt, `pnyx-axi card <id>` lists the request with its options and `pnyx-axi reply <id> --answer <request key> --json <answer>` answers it in that session's tmux pane (see `pnyx-axi reply --help`).

To start a worker for a task, run `pnyx-axi task start <task> --via paseo|firstmate|command` (see `pnyx-axi task --help`). The board's orchestrator, Hydra, follows the `pnyx-hydra` skill; `pnyx-axi setup hydra --home <firstmate home>` gives it to a Firstmate home.
