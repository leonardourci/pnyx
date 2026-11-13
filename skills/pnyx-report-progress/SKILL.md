---
name: pnyx-report-progress
description: Use when you are a worker attached to a Pnyx task (your prompt names the task, or PNYX_TASK is set) and need to report your state through pnyx-axi.
user-invocable: false
metadata:
  internal: true
---

# Pnyx worker

Work only on your assigned task and copy. Hydra supervises it. Pass `--hydra <hydra>` on every command; retain your assigned actor and session identity. Suggestions never grant authority. Before changing code, read the project's AGENTS.md, CLAUDE.md, CONTRIBUTING.md and applicable skills. Follow the worker header's authority and landing rules.

At startup read `task show <task>` and `task history <task>`. Use `task messages <task> --id <message-id> --before 3 --after 3` for a referenced reply and its context; `--seq`, `--at`, inclusive `--from`/`--to` ranges and returned `--cursor` values navigate your current session and the owner's replies; `task chat <task> --session <session>` reads a past session. Successful assignment already records working. Run `pnyx-axi <command> <subcommand> --help` for syntax and follow contextual hints; load [detailed reporting](references/reporting.md) for investigations, questions, report-review, replies and landing details.

Lifecycle declarations describe state: `task status <task> working|needs_you|paused|blocked|done --note "..."`. Silence changes nothing. Ask Hydra procedural questions that project instructions leave open (for example, which integration test command to use) with `pnyx-axi task ask <task> --question "<question>" --hydra <hydra>`. Hydra can route them to its helper; never ask the owner directly. Hosted tool permission requests still use the harness permission flow. Unsettled product or architecture choices also use `task ask`; wait for the answer before dependent work and continue independent authorized work. Never fabricate approval or implement an unsettled default.

Send routine progress with `hydra send --task <task> --kind progress --text "..."`. Send an actionable result with `hydra send --task <task> --text "<result with full links>"` without `--kind progress`, before pausing. `working` and `paused` do not wake Hydra. Queued/recorded receipts do not confirm owner delivery; Hydra relays results. Use `task status blocked` for an obstacle and `needs_you` for attention, never as a substitute for `task ask`.

To wait for another task, use `task status <task> paused --wait-for <dependency> [--ready-when task-done|pr-opened|pr-merged]`. The default is `task-done`. Pnyx checks the condition and resumes you once with a steer naming the dependency and PR link, across restarts. Do not poll or ask Hydra to watch it. Holds and unanswered questions still gate resumption. A paused note without a dependency remains visible on the card.

Before ending, declare a deliberate wait with `paused --note "<what resumes work>" --until <time>` when its end is known. Use `--hold` only when the owner/Hydra requests it. A long test/build is working, not a wait. Report blocked and stop after the same obstacle defeats two attempts. Code is finished only when landed under the project's rule: commit/push/open/link the required PR, never merge it yourself. A ready PR waits for review; Pnyx follows its checks and landing.

For a worker Pnyx runs, new instructions arrive with their text and are marked read; a notice that only names inbox IDs means run `task inbox read <task>`, as you also do at startup and before ending. Receipt means read, never completed work. Apply messages in order, report progress/blockers separately, ask decisions through `task ask`. After a crash read `--all`, verify existing effects and retain idempotency keys before retrying. Reconcile uncertain delivery from its receipt. Historical transcripts do not resume work.

Read [review pages and queued work](references/workflows.md) before managing a review page or accepting a queued assignment. Do not create, assign or attach other tasks/workers, and leave manual card moves to the owner/Hydra. Ask Hydra when work needs splitting.
