---
name: pnyx-manage-workers
description: Use when you are Hydra and are about to start, queue, continue, replace, move or detach a task's worker, remove a task copy, or answer a worker's permission request.
user-invocable: false
metadata:
  internal: true
---

# Hydra workers

## Start a worker

Start in the UI requests a worker in your chat; you choose the project, copy or folder, launch route and agent. Read the task's history and current record before starting it. A request to start fresh may still have an old session attached; inspect it before choosing whether to continue or replace it.

Before starting, refresh a missing or out-of-date project profile as the Hydra contract describes. Pnyx adds shared project memory and the standing repository-conventions instruction to every opening prompt and task handoff. Keep briefs task-specific; do not repeat that instruction.

An explicit owner choice comes first: pass their `--harness`, `--model`, `--effort`, `--mode` and `--fast on|off` exactly. Only `--harness` and `--model` choose what runs: they start even when no rule lists that harness or model, Pnyx checks the harness’s own catalog and login, records an owner override, and does not let quota veto the choice. `--effort`, `--mode` and `--fast` alone only change settings: quota still picks the candidate and account and skips spent ones, then those settings apply.

Otherwise read `pnyx-axi rule list --hydra <hydra>` first, pick the named rule whose plain-language `when` fits the task, and run

```sh
pnyx-axi task start <task> --rule <name> --reason "<why>" --hydra <hydra>
```

Use the `default` list only when no named rule fits. Pnyx reads each candidate's quota through quota-axi and walks that provider's account list, including any project override. Candidates with a known spendPriority rank highest first, and unknown quota ranks below every known one; unknown quota is usable and shown as unknown. On a tie, or when every usable candidate's quota is unknown, the first listed starts, so a rule's order is its preference. The task records the chosen rule, model, account, quota evidence and any override. If a chosen rule has no usable candidates, all its accounts are spent, or any account is signed out, tell the owner what stopped the start. Never quietly choose a weaker rule or an unlisted account. Ask the owner to sign in when needed; Pnyx only stores login folders.

When the owner asks to change rules or accounts in chat, make the whole change one proposal: read `pnyx-axi rule show --hydra <hydra>` for the document and its revision (`rule schema` lists every field and allowed value), write a patch file `{"version":1,"expected":{"revision":<n>},"patch":{...}}` naming only what changes (`null` removes a key; a list replaces the whole list), preview it with `pnyx-axi rule apply --file <path> --check --hydra <hydra>`, fix every problem it lists, then run it with `--propose` instead of `--check`. For one small change, `pnyx-axi rule propose set|remove|accounts <same arguments> --hydra <hydra>` or `pnyx-axi account propose set|remove <same arguments> --hydra <hydra>` does the same. Pnyx saves a pending change with its before and after values and Confirm and Dismiss in your chat. Tell the owner what you proposed; never confirm it yourself, ask them to run commands, or change the files directly. A proposal whose values changed since shows as out of date: propose it again from the current revision. When your session is set to Bypass permissions, or Codex's `never`, run the same command without `--propose` or `propose`; it applies at once.

Every worker's opening prompt starts with Pnyx's worker header: its task, the copy it stays in, that it runs routine commands without asking, that it asks you through `task ask` about unsettled product or architecture choices, proposed departures from an approved design, merges, destructive or shared writes and work outside the task, and where it stops: its project's landing rule, or, for an investigation, its stored report. Apply Questions and scope in the Hydra contract before answering or escalating through its card.

Routes:

- No `--via` (or `--via pnyx`): the Hydra's server runs Claude Code or Codex using the selected account and the candidate's model, effort, mode and Fast from its first turn, with the brief as its first prompt. When the owner asks for other settings for one start, pass `--model <model>`, `--effort <effort>`, `--mode <mode>` or `--fast on|off`: they replace the candidate's own from the first turn, the model must be in the harness's catalog, and effort and mode must be values that harness offers. Do not start on the rule's settings and change them afterwards to fake an override. `--folder <absolute path>` sets the folder when the task has none. `pnyx-axi reply <task> --text "<message>"` reaches it on the same account after a server restart. A worker cut by a Pnyx restart continues once by itself. One still marked interrupted stopped mid-turn, or was cut again: send it a message to continue unless its task says otherwise.
- `--via paseo --rule <name> --folder <absolute path>` starts it in the local Paseo daemon on a candidate Paseo offers. `--harness claude|codex` honors the owner’s harness choice even outside the rule; `--prompt "<opening message>"` replaces the default opening message (the header stays).
- `--via command [--prompt "<text>"]` runs the Hydra's own start command in the task's folder. `--command "<name>"` selects the assigned project's named command from `project list`. `bringsOwnFolder` means the command manages its own folder, so Pnyx makes no task copy and runs it from the project folder unless its contract needs `--folder`.
- `--via firstmate [--prompt "<text>"]` hands the request to the Firstmate home that is this Hydra.

A successful start records working and places the card in the same accepted assignment write; no first status or placement command is needed. A task holds one worker; `task detach <task>` frees it without stopping the agent and parks eligible unfinished work, preserving Done and unresolved owner gates. A repeated `--event-id` never starts a second worker.

A start's receipt is its record. A success through Pnyx or Paseo means the worker is attached, so do not reread the task to confirm it. `NOT_RUNNING` means nothing was sent: retry once with the same `--event-id`, and if it fails the same way, follow its help or tell the owner. Read the task only when a start's outcome is unknown, such as a timeout after the request left.

## Continue or replace

After an outside Claude Code or Codex session ends, `pnyx-axi task continue <task> --reason "<why>" --hydra <hydra>` adopts its native session in Pnyx; the next reply resumes it in its recorded folder. Use `--check` to read eligibility first. Never continue while its terminal still runs it; a running or unverified process refuses the handoff. If the folder is missing, use `task start <task> --via pnyx --replace-session <session> --folder <path>` to start fresh from the brief; the old attachment stays until the new start passes validation.

A lost worker (presence `gone`, or a session that cannot be continued) is relaunched without asking the owner when its folder still holds its work: `task start <task> --via pnyx --replace-session <session> --folder <its folder>`. The new worker's first prompt names the lost session and its last declaration, and it reads the task history. Count the relaunches in `task history`; after two that fail, stop and tell the owner what failed and what work the folder keeps.

## Queue related tasks

Compare a new task's expected files and area with live workers' briefs and changes. Queue only real
file overlap or a task that builds on that worker's result; a shared project alone is not a reason.
Start an independent worker for independent work.

```sh
pnyx-axi task queue <next> --behind <task|session> --reason "<overlap or dependency>" --hydra <hydra>
pnyx-axi task reorder <next> --behind <task|session> --reason "<why>" --hydra <hydra>
pnyx-axi task unqueue <next> --reason "<why>" --hydra <hydra>
```

Behind a session or its current task appends to the queue; behind a queued task inserts immediately
following it. The tasks must use the same project and have no worker or active copy. Give each a complete
brief. Cards remain in Queued with their worker and position; the worker's card lists its ordered queue.
The owner can also queue, reorder or unqueue from the card's menu.

The server checks every 30 seconds. An open pull request holds the queue while its worker handles
reviews. After all linked pull requests merge, or a task without a pull request is declared done and
its commit lands, an idle worker takes the first queued task. Pnyx fetches origin, discovers its current
default branch, verifies a clean isolated folder and landed commits, creates a fresh branch, transfers
the copy to the next task, attaches the session and sends the next brief. Old branches stay intact.
Automatic handoff declares working and restores the next card to In progress atomically; manual attachment still leaves placement alone.

Done cleanup keeps a folder while its worker has queued tasks. Project copy commands have their own
folder contracts, so those queues return to Queued for a fresh worker rather than reusing their folder.
Failed branch preparation also releases the queue with its reason; no work is discarded.

A dead or detached worker releases the queue. A working, blocked, paused or waiting worker with no sign
of life for 30 minutes does too. After three tasks in one queue run, or a transcript of 2 MiB, remaining
tasks return to normal Queued with a short note naming the earlier task. Read that history, carry over
only useful context, and dispatch a fresh worker. Unknown presence keeps the queue waiting.
Firstmate owns assignments on its linked Hydras; ask Firstmate to queue there.

## Move a worker to another task

For manual reuse outside an automatic queue, a worker whose task is done can take a related task. First
confirm the worker is idle, its work has landed, and the next task uses the same project. Rely on the worker's checked
`done` declaration, then inspect its copy and folder: Done cleanup returns a clean landed slot to the
pool, reserving it while its worker remains attached.
Reuse only after copy settlement is complete and the folder will remain. If the folder is gone, start a
new worker from the current default branch instead; `task attach` cannot restore a missing copy.

For a surviving folder, write the next task's brief with the branch preparation below as its first step,
then

```sh
pnyx-axi task attach <next> --session <session> --hydra <hydra>
```

moves the session to `<next>` (the old task is left without a worker, so no detach first) and sends
`<next>`'s brief as its next message. `<next>` must have no worker of its own, and only a session Pnyx or
Paseo runs, or one in a terminal, can be attached. The worker retains its session and current folder;
attachment does not fetch Git history or switch branches. Check the command's brief delivery result
before treating the handoff as delivered.

### Prepare the branch before new work

Include these instructions in every moved worker's brief and every post-merge follow-up sent to its
original task. A resumed session keeps context, not permission to continue on a merged branch. Before
editing or committing, the worker must:

1. Verify it is in the intended project's isolated folder, no other worker is using it, and `git status
   --porcelain` is empty. If work remains uncommitted or unlanded, stop and report it to Hydra; never
   reset, discard or hide it to make reuse possible.
2. Fetch the remote and discover its current default branch:

   ```sh
   git fetch origin
   git remote set-head origin --auto
   git symbolic-ref --short refs/remotes/origin/HEAD
   ```

      Use the remote-tracking ref printed by the last command, such as `origin/main`. If fetch or
   default-branch discovery fails, stop and report it; a stale local branch is not a substitute. Confirm
   all commits on the old branch, including any unpushed commits, have landed on the fetched default
   branch or through their merged pull request.
3. Create a new, unused branch for this task from that fetched default ref:

   ```sh
   git switch --no-track -c <unique-task-branch> <fetched-default-ref>
   ```

      Give a post-merge follow-up its own new branch too. Leave the old branch and its commits intact;
   never reuse its name, reset it, or base the new work on it.
4. Begin the brief only after the switch succeeds. Link the new pull request to the task; a merged pull
   request cannot receive the follow-up commits.

For folders created by a project's copy command, follow that project's preparation contract as well. If
its folder cannot safely serve the next task, start a fresh worker instead. Copy retention and pooling
are separate from session attachment.

## Task copies

A task with an attached project starts in its own copy (a git worktree on branch `pnyx/<hydra>-<task>`, or the project's copy command); `--in-place` works in the project folder itself and is refused while another Hydra's worker runs there. When the task reaches Done, Pnyx releases a clean copy whose work landed to the project's pool, where the next task's start takes it on a fresh branch; a copy a worker still runs in stays its own. Otherwise it keeps the copy, flags it and messages you: land the work and run `pnyx-axi task copy <task> remove --hydra <hydra>`, or, when it already landed another way or is empty, `pnyx-axi task copy <task> remove --safe --reason "<why>" --hydra <hydra>`. Never discard work that never landed; ask the owner, who runs `--discard`. Automatic folder handoff belongs to the worker queue; manual `task attach` keeps the branch preparation contract above.

## Permission requests

Hosted workers' tool permission requests appear in `hydra check` as `task.permission` events. Read `pnyx-axi task show <task> --full --hydra <hydra>` for the request id, tool, input and status, then answer a pending one with

```sh
pnyx-axi task permission <task> <request> allow|deny --actor hydra --reason "<why>" --hydra <hydra>
```

The reason is posted in your chat; further allows on the same task fold into that line, and their reasons stay in the task's history. The first answer wins, expired requests cannot be answered, and once nothing else on the task waits for the owner, answering returns its card from Needs you to In progress. Command and file approvals apply to that call; Codex turn permissions last only for the named turn.

A request with `questions` is a worker asking: allow it with `--answer '{"answers":[{"pick":[1]},{"text":"..."}]}'`, one entry per question (options numbered from 1, `text` for your own answer); one with `form` takes `--answer '{"values":{"<field>":"<value>"}}'`. Deny skips it. Answer only what the brief or the owner already settled; otherwise leave it for the owner.
