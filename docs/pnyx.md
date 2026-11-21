# Pnyx command line

Pnyx runs its UI and stores work separately for each Hydra and task. The `pnyx` command handles actions that need an immediate answer. Output is plain text; add `--json` for scripts. Errors return a nonzero exit status. Use `--help` for syntax.

```sh
pnyx serve --hydra work
pnyx setup --preview
pnyx setup check
pnyx debug health --hydra work --json
pnyx board --hydra work
pnyx task create --title "Fix the empty state" --brief "Implement and check the empty state" --project app --hydra work
pnyx send --text "Review the open work" --hydra work
pnyx send --task <task> --text "Also check mobile" --hydra work
pnyx answer <task> <question> --text "Use the existing design" --hydra work
```

`task create` saves the task and starts its worker. Pass an explicit `--harness`, `--account`, `--model`, `--effort`, `--mode`, `--fast` or `--rule` when required. The receipt includes the task ID and whether its worker started; a failed start keeps the task and names the blocker. Configure Hydras, projects, dispatch and view settings in the UI. The Hydra header keeps its fold controls before its name; the fixed ＋ after the name requests a project attachment in chat while project chips scroll beside it. Stop a foreground server with Ctrl+C. Use `/upgrade` in Hydra's chat to upgrade.

`send` addresses Hydra by default, or a task's worker with `--task`. Give `--text` or `--file <path|->`. Use `--idempotency-key` when a caller needs to reconcile an uncertain delivery without duplicating the message. A queued receipt does not confirm delivery.

`answer` records an answer to a saved task question and relays it to its worker. Hydra answering on behalf of the owner supplies `--from-message <id>` to identify the owner's source message. Answering never invents owner authority.

## Reads during the storage cutover

The default home is `~/.pnyx`; `PNYX_HOME` selects another home. Current agent contexts still need the existing read commands while the app is connected to the file store. These reads use plain text by default and accept `--json`:

```sh
pnyx task list --hydra work --json
pnyx task show <task> --full --hydra work --json
pnyx task history <task> --hydra work --json
pnyx hydra check --hydra work --json
pnyx hydra digest --hydra work
pnyx hydra messages --hydra work --json
pnyx hydra history --hydra work --since origin --json
pnyx task inbox read <task> --hydra work --json
```

Task messages, chats, updates, sessions, questions and reminders remain readable. The read-only project, column, dispatch, account, layout, view, settings, integrations, context, logs, history, card and Oracle paths also remain available. Inbox reads acknowledge receipt as before. Mutation subcommands such as task rename, layout reset and logs clean are not exposed by this CLI.

Workers continue to report through their assigned `worker.log`; the server observes it and keeps the task record. After the app's file-store cutover, direct reads of `hydra.log`, `task.log`, `worker.log` and the snapshot replace these transitional read commands.

Only the assigned worker appends to its `worker.log`, one complete line per update:

```text
note: Investigated the failing flow
needs-you: Which of the two designs should I use?
blocked: The required account cannot sign in
link: https://example.com/result Result
done: Implemented and verified the requested behavior
```

A `note` updates the latest card line; running and idle come from the worker session. `needs-you` asks for a decision, `blocked` records an obstacle, `link` attaches a result, and `done` reports completion. Follow the task brief's landing rules before reporting done. Do not edit server-owned records.

## Isolated checks

Use a temporary `PNYX_HOME` for trials. When portless is installed, use `PNYX_HOME=<temporary-dir> portless <unique-name>.pnyx pnyx serve` and the URL it prints. Otherwise use `--port 0`. Setup changes hooks, skills or the login service beyond the selected home; use `--preview` to inspect those targets.
