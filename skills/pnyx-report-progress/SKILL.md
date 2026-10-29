---
name: pnyx-report-progress
description: Use when you are a worker attached to a Pnyx task (your prompt names the task, or PNYX_TASK is set) and need to report your state through pnyx-axi.
user-invocable: false
metadata:
  internal: true
---

# Pnyx worker

You work on one task of a Pnyx Hydra. Hydra, the Hydra's orchestrator, assigned it; the user and Hydra follow it on the Hydra. Your task id is in your first prompt (and in `$PNYX_TASK` when the Hydra's own command started you), your Hydra in `$PNYX_HYDRA`; pass `--hydra <hydra>` on every command.

## Start

Before changing anything, read your project's AGENTS.md, CLAUDE.md and CONTRIBUTING.md when present, and its skills under `.agents/skills`, `.claude/skills` and `skills/`. Follow them over generic habits, and use the project's skills for the jobs they cover.

Read the task before working: `pnyx-axi task show <task> --hydra <hydra>`, then `pnyx-axi task history <task> --hydra <hydra>` for what earlier workers did and where they stopped. `pnyx-axi task chat <task> --session <session> --hydra <hydra>` reads a past worker's conversation.

## Declare progress and phase changes

Successful task/agent operations record their own lifecycle facts. Declare meaningful progress and phase changes with:

```sh
pnyx-axi task status <task> working --note "<what you are doing>" --hydra <hydra>
pnyx-axi task status <task> needs_you --note "<the question>" --hydra <hydra>
pnyx-axi task status <task> blocked --note "<what stops you>" --hydra <hydra>
pnyx-axi task status <task> paused --note "<why, and what resumes it>" [--until <time> | --hold] --hydra <hydra>
pnyx-axi task status <task> done --note "<the result, with links>" --hydra <hydra>
```

- A successful start or queue assignment already records `working`; no first status call is needed. Use `working` for meaningful new work or a resumption note.
- Ask a question or for a decision with `pnyx-axi task ask <task> --question "<one short question>" [--context "<a few lines>"] [--choice "<label>[: <description>]"]... [--recommend <n>] [--details-file <path>] --hydra <hydra>`. It goes to Hydra, which answers it or hands it to the owner, and the answer arrives as a message that names the question. Keep working on what does not depend on it and wait for the answer before what does. Choices are optional; evidence goes in `--details` or `--details-file`, not in the question. A worker started without `PNYX_ACTOR` set passes `--actor worker:<task>`.
- Use plain Markdown for notes, questions, choices and reports: paragraphs, bold, lists, code, links and tables render on the card. Keep status notes concise; a question belongs in `task ask`, not in a status note. Your latest status note or progress report is the task's current state on the owner's card: lead with the task-level result or what you wait on, then what remains, naming each unresolved part when there are several; keep evidence and process detail out of it.
- Write an image as `[image: <absolute path>]` where it belongs in a note, question or report, never as a bare path; Pnyx shows it as an image chip.
- Ask when the saved owner's ask leaves a product or architecture choice open, or your plan would depart from an approved design. Proposed defaults with unsettled consequences need an answer too; “proceeding unless you say otherwise” in a report does not authorize dependent work.
- Your `needs_you` and `blocked` notes wake Hydra; they are not owner questions. Ask Hydra with `task ask` when you need an answer. Declare `blocked` for a real obstacle, `paused` for a deliberate wait, `done` only when the work is finished. A long command such as a test suite is not a wait; a wait with a known end, such as checks due by 15:00, takes `--until <time>` (an ISO time, `"in 2 hours"` or `"tomorrow 9:00"`), and Hydra checks on it then.
- For code work, finished means landed by the project's rule, which your worker header's Landing line states. With a pull request: push, open it ready and link it. Confirmed ready metadata creates a Merge/Hold owner question under owner-merge rules; if metadata is not available yet, or Hydra is the merger, declare `needs_you` with its URL; never merge it yourself. Do not wait on it: Pnyx follows it, sends you its failed checks and new review comments to fix on your branch (fix them there and push; do not reply on the pull request, since your replies would come back as new comments), and declares the task done when it merges. With branch-only landing: commit on your branch, then declare `done`. Pnyx refuses `done` while files are uncommitted or the work has not landed, and says what is missing.
- An investigation answers with a report that stands alone. Store it with `pnyx-axi task report <task> --file <path> --hydra <hydra>`, then review the whole report for genuine owner choices. Have Hydra reuse an existing gated task or create separate owner work and ask with `task ask <gated-task> --from-report <origin-task> --question "<choice>"`; workers can file a question to Hydra on their task and have Hydra create the linked owner question. Read the report id from `task report <task>`, and attest with `task report-review <task> --report <report-id> --call <gated-task>/<ask-id>` for every call, or `--none` when nothing needs the owner. Recommendations with no owner choice create no task. Then declare `done`; completion, hiding and promotion require the current report inventory. Finishing or hiding the report does not close its linked questions. Record answers through existing answer/source-message or evidence-close operations, never fabricated approval. A report does not authorize building. If the owner turns it into the build, a message tells you so: start a fresh branch from the up-to-date default branch and carry over only the changes the build needs.
- Declare `blocked` and stop when the same obstacle defeats two attempts; name the obstacle and the evidence from both attempts.
- Declare a deliberate wait with `task status <task> paused --note "<what ends the wait, and when to check again>"`; name the condition that lets work resume. When it clears, a delivered resume reply restores working, or declare `working` with a resumption note.
- When the owner or Hydra stops you, declare `paused --hold --note "<what resumes it>"`: a hold waits for their word and never wakes Hydra on a timer. A pause with neither `--until` nor `--hold` wakes Hydra after 4 hours.
- Mention every pull request by its full URL in reports and status notes. Before linking a ready pull request, report what it changes and explain any expected or stale check failures, including a deliberately held verify marker. The merge question includes the latest worker report or status note alongside the PR title and check counts.
- A completion note accounts for each part of the saved owner's ask, with results and proof or the remaining limitation.
- Your declarations place your card: `working` moves it to In progress, `needs_you` or `blocked` keep it In progress with their note for Hydra, and `done` to Done; `paused` parks it with its note and wait deadline. Answering the actual owner question or permission restores the previous phase unless another owner gate remains.
- Silence changes nothing: idling, finishing a turn or exiting never moves the task. Declare a phase change once, not every step. Ending your turn while still declared `working` wakes Hydra to ask why, so declare what you wait on before you stop.

Send routine progress with `pnyx-axi hydra send --task <task> --kind progress --text "<what changed>" --hydra <hydra>`: it updates your card and reaches Hydra with its next wake, without waking it. A report Hydra must act on now, such as a page link to hand the owner, leaves out `--kind progress`. Questions, blockers and results never go this way: they take `task ask` and `task status`. Hydra reads every report as yours, never as the owner's words, and a report never answers a question.

For a native hosted worker (`PNYX_STEERING_WORKER` is set), replies arrive as durable inbox notices, including during a turn. Run `pnyx-axi task inbox read <task> --hydra <hydra>` at startup, on each notice and before ending a turn. This records read acknowledgements for the returned pending messages and stops their reminders. An acknowledgement means read, never completed work. Apply instructions in order, report progress and blockers with `task status`, and file any needed question with `task ask`. `task inbox ack <task> <message-id> --session <session> --generation <generation>` also records receipt and is safe to repeat with the claim returned by read. Duplicate notices do not create new instructions. Checkpoint side effects; after a crash, use `inbox read --all` and verify existing effects before repeating work. Transport delivery alone is not a read receipt. Firstmate workers keep Firstmate's own inbox contract.

The owner's comments on your replies arrive under `## Comments on your reply from <time>`, one heading per commented reply. Each comment opens with `### Comment N`, numbered from 1 under each such heading, then the quoted passage as `>` lines, a blank line and the owner's comment as plain lines; a quote of three words or fewer is followed by its paragraph as a nested `> >` quote, for context. A comment line the owner started with `>` or `#` arrives escaped with a `\`. A `## Message` heading follows with the owner's message only when they wrote one. Address every numbered comment together with the message.

Other replies reach you as ordinary messages in your session. Link pull requests or tickets with `pnyx-axi link <task> --url <url> --hydra <hydra>`.

## Review pages

When Lavish (`lavish-axi`) is installed and the owner should review something on a page, you own that page end to end; Hydra only relays its link.

- Build it with Lavish in your copy and keep it out of your commits. Open it with `lavish-axi <page>`, which prints the page's link.
- Register the server-owned listener with `pnyx-axi task source lavish <task> <source-id> --page <page> --executable "$(command -v lavish-axi)" --hydra <hydra>`. Use a distinct source id for each round. Registration is durable; it is not proof of listening. Check `task source list <task>` for a running poll, and, when a reply was staged, its accepted receipt before reporting listening. Do not start a separate poll or background pipe.
- Read each captured round completely with `task source read <task> <source-id>` and `task inbox read <task>`. Apply every item once, checkpointing effects and the question/work IDs you created so a restart can verify them. Inbox read records receipt; source handling remains a separate step after incorporating the round.
- For a nonterminal round, save a concise reply in a file and run `task source lavish <task> <new-source-id> --page <page> --executable "$(command -v lavish-axi)" --after <old-source-id> --sequence <round-sequence> --session <session> --generation <generation> --agent-reply-file <path> --hydra <hydra>`. This handles the old round, persists the reply text and identity, posts it once, then starts the next poll only after acceptance is captured. Repeat the same registration to inspect/recover its identity; never mint a second successor for the same round. Failed publication or re-arm stays a retained source result, not a listening claim.
- A final round (`ended` or feedback with `session_ended`) includes empty End. Read its inbox message, incorporate its content, then run `task source handled <task> <source-id> <sequence> --session <session> --generation <generation> --hydra <hydra>`. Stop listening and do not reopen or re-arm it. After an interrupted poll, read the retained uncertainty and verify what already happened before explicitly recovering with a new source; there is no blind retry of a destructive poll or uncertain reply.
- Send Hydra one short line with `pnyx-axi hydra send --task <task> --text "<round N: what changed>" --hydra <hydra>`. The first line carries the page's link; later rounds add `--kind progress`. File real owner choices through `task ask`, retain their IDs, and include unresolved choices in the existing report-review inventory when finishing. A page comment or close does not answer a separate owner gate.

Pnyx usually starts you in your task's own copy of the project, on its own branch. Commit your work there and link its pull request: once the task is done, Pnyx removes the copy only if nothing is left uncommitted and the work has landed.

## A queued next task

Keep handling review fixes on your current pull request until it merges. A new message beginning with
another task's worker header is the next assignment: use its task id for every declaration. Pnyx has
fetched the current default branch and switched your clean folder to the new task's branch. Verify the
branch and status before editing; stop and tell Hydra if either differs from the handoff. Leave the
previous branch and its commits intact, and give the next task its own pull request.

## Limits

Work on your task only. Do not create, assign or attach other tasks or workers, and leave manual card moves to the owner or Hydra's exceptional corrections. If the task needs splitting, say so with `needs_you`.
