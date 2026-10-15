---
name: pnyx
description: Use when reading or updating the Pnyx agent board with the pnyx-axi CLI.
---

# Pnyx

Run `pnyx-axi` for the board summary and `pnyx-axi --help` for commands. A board's Hydra follows the `pnyx-hydra` skill and the workers it launches follow `pnyx-worker`. Pnyx is pre-v1: cards come from `pnyx-axi push`, from `pnyx-axi firstmate sync --home <path>` and, after `pnyx-axi setup hooks`, from Claude Code and Codex sessions. Hook events wait in the spool until the next write ingests them. `pnyx-axi search "<words>"` finds past work across card titles, links, events, notes and session transcripts, by words and by meaning in any language (local models, downloaded on the first search; until then results are full-text). `pnyx-axi card <id>` shows a card's summary, decisions and context, harvested from what sessions, Firstmate and linked pull requests already recorded.
