---
name: pnyx-hydra-workers
description: Use when you are Hydra and are about to start, continue, replace or detach a task's worker, remove a task copy, or answer a worker's permission request.
---

# Hydra workers

## Start a worker

Start in the UI requests a worker in your chat; you choose the project, copy or folder, launch route and agent. Read the task's history and current record before starting it. A request to start fresh may still have an old session attached; inspect it before choosing whether to continue or replace it.

Read `pnyx-axi rule list --hydra <hydra>` first, pick the named rule whose plain-language `when` fits the task, and run

```sh
pnyx-axi task start <task> --rule <name> --reason "<why>" --hydra <hydra>
```

Use the `default` list only when no named rule fits. Pnyx reads each candidate's quota through quota-axi and walks that provider's account list, including any project override. Candidates with a known spendPriority rank highest first, and unknown quota ranks below every known one; unknown quota is usable and shown as unknown. A tie, or several candidates whose quota is all unknown, stops the start with `DISPATCH_TIE` and names them: when they differ by harness, pick one with `--harness`; otherwise ask the owner to narrow the rule. Never pick one at random. The task records the chosen rule, model, account, quota evidence and any override. If a chosen rule has no usable candidates, all its accounts are spent, or any account is signed out, tell the owner what stopped the start. Never quietly choose a weaker rule or an unlisted account. Ask the owner to sign in when needed; Pnyx only stores login folders.

Every worker's opening prompt starts with Pnyx's worker header: its task, the copy it stays in, that it runs routine commands without asking, and that it escalates only real decisions to you (merges, destructive or shared writes, work outside the task). Answer those escalations through its card.

Routes:

- No `--via` (or `--via pnyx`): the Hydra's server runs Claude Code or Codex using the selected account and the candidate's model, effort, mode and Fast from its first turn, with the brief as its first prompt. When the owner asks for other settings for one start, pass `--model <model>`, `--effort <effort>`, `--mode <mode>` or `--fast on|off`: they replace the candidate's own from the first turn, the model must be in the harness's catalog, and effort and mode must be values that harness offers. Do not start on the rule's settings and change them afterwards to fake an override. `--folder <absolute path>` sets the folder when the task has none. `pnyx-axi reply <task> --text "<message>"` reaches it on the same account after a server restart. A task marked interrupted stopped mid-turn: decide whether to send it a message to continue.
- `--via paseo --rule <name> --folder <absolute path>` starts it in the local Paseo daemon on a candidate Paseo offers. `--harness claude|codex` filters the rule's candidates; `--prompt "<opening message>"` replaces the default opening message (the header stays).
- `--via command [--prompt "<text>"]` runs the Hydra's own start command in the task's folder. `--command "<name>"` selects the assigned project's named command from `project list`. `bringsOwnFolder` means the command manages its own folder, so Pnyx makes no task copy and runs it from the project folder unless its contract needs `--folder`.
- `--via firstmate [--prompt "<text>"]` hands the request to the Firstmate home that is this Hydra.

A task holds one worker; `task detach <task>` frees it without stopping the agent. A repeated `--event-id` never starts a second worker.

## Continue or replace

After an outside Claude Code or Codex session ends, `pnyx-axi task continue <task> --reason "<why>" --hydra <hydra>` adopts its native session in Pnyx; the next reply resumes it in its recorded folder. Use `--check` to read eligibility first. Never continue while its terminal still runs it; a running or unverified process refuses the handoff. If the folder is missing, use `task start <task> --via pnyx --replace-session <session> --folder <path>` to start fresh from the brief; the old attachment stays until the new start passes validation.

## Task copies

A task with an attached project starts in its own copy (a git worktree on branch `pnyx/<hydra>-<task>`, or the project's copy command); `--in-place` works in the project folder itself and is refused while another Hydra's worker runs there. When the task reaches Done, Pnyx removes a clean copy whose work landed. Otherwise it keeps the copy, flags it and messages you: land the work and run `pnyx-axi task copy <task> remove --hydra <hydra>`, or, when it already landed another way or is empty, `pnyx-axi task copy <task> remove --safe --reason "<why>" --hydra <hydra>`. Never discard work that never landed; ask the owner, who runs `--discard`.

## Permission requests

Hosted workers' tool permission requests appear in `hydra check` as `task.permission` events. Read `pnyx-axi task show <task> --full --hydra <hydra>` for the request id, tool, input and status, then answer a pending one with

```sh
pnyx-axi task permission <task> <request> allow|deny --actor hydra --reason "<why>" --hydra <hydra>
```

The reason is posted in your chat; further allows on the same task fold into that line, and their reasons stay in the task's history. The first answer wins, expired requests cannot be answered, and answering leaves the card in its column. Command and file approvals apply to that call; Codex turn permissions last only for the named turn.

A request with `questions` is a worker asking: allow it with `--answer '{"answers":[{"pick":[1]},{"text":"..."}]}'`, one entry per question (options numbered from 1, `text` for your own answer); one with `form` takes `--answer '{"values":{"<field>":"<value>"}}'`. Deny skips it. Answer only what the brief or the owner already settled; otherwise leave it for the owner.
