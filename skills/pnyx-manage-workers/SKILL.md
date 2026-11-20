---
name: pnyx-manage-workers
description: Use when you are Hydra and a worker needs more than task create: an owner's harness or model override, a dispatch rule change, another launch route, a lost or ended worker, a queue, moving a worker to another task, a browser grant, a flagged task copy or a permission request.
user-invocable: false
metadata:
  internal: true
---

# Hydra workers

`task create` starts a task's worker through the dispatch rules. This skill covers the starts and moves that need more; `pnyx-axi task --help` lists every flag.

## Owner choices and dispatch rules

Pass the owner's explicit `--harness`, `--model`, `--effort`, `--mode` and `--fast on|off` exactly on `task create` or `task start`; never start on the rule's settings and change them afterwards. Otherwise `rule list` shows the named rules: pass `--rule <name>` for the one whose `when` fits the task, and leave the `default` list for when none does. `rule now` shows which candidate would start. When a start reports no usable candidate or a signed-out account, tell the owner what stopped it rather than switching to a weaker rule, and ask them to sign in when that is the fix.

To change rules or accounts, read `rule show` and `rule schema`, preview a patch with `rule apply --file <path> --check`, fix what it lists, then apply it; `rule set|remove|accounts` and `account set|remove` cover one small change. A permission increase goes through `rule apply --propose` and the owner's Confirm.

## Other routes

`--via paseo`, `--via command [--command <name>]` and `--via firstmate` start the worker outside Pnyx's own server. Use them when the owner or the project asks; `task start --help` gives each route's flags.

## Lost or ended workers

- An ended outside Claude Code or Codex session: `task continue <task> --reason "<why>"` hosts it in Pnyx, and `--check` reads eligibility first.
- A lost worker (presence `gone`, or a session that cannot be continued) whose folder holds its work: relaunch it there without asking the owner, `task start <task> --via pnyx --replace-session <session> --folder <its folder> --reason "<why>"`. After two failed relaunches, tell the owner what failed and what the folder keeps.
- A worker still marked interrupted after a restart continues only when you `reply` to it; send one unless its task says otherwise.
- `NOT_RUNNING` means nothing was sent: retry once with the same `--event-id`, then follow its help or tell the owner. Read the task only when a start's outcome is unknown.

## Queues

Queue only real file overlap or work that builds on another worker's result: `task queue <next> --behind <task|session> --reason "<overlap or dependency>"`, and `task reorder` or `task unqueue` to change it. The server hands the next task over once the current work lands. A released queue carries a handoff note: read that history and start a fresh worker.

## Move a worker to another task

A worker whose task is done and landed can take a related task in the same project while its folder remains: `task attach <next> --session <session>` moves the session and sends `<next>`'s brief. Make the brief's first step a check that the folder is clean, then a new branch from the freshly fetched default branch; work that has not landed is reported, never reset or discarded. When the folder is gone, start a fresh worker instead.

## Browser

For a UI worker, `task start --tool browser` gives one isolated headless browser. When a worker asks for one, decide within the task, run `task tools <task> --grant browser` and answer its question.

## Task copies

Pnyx keeps and flags a Done task's copy when its work did not land, and messages you. Land the work and run `task copy <task> remove`, or `task copy <task> remove --safe --reason "<why>"` when it already landed another way or is empty. Only the owner discards work that never landed.

## Permission requests

Pending requests show in `hydra check` and `task show <task> --full`. Answer what the brief or the owner already settled with `task permission <task> <request> allow|deny --reason "<why>"`, adding `--answer` for a question or form (`task permission --help`), and leave the rest for the owner.
