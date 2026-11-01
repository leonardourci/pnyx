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
