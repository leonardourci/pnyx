# Pnyx command line

The `pnyx` command handles immediate actions. Output is plain text by default. Add `--json` for scripts. Successful receipts go to stdout. Refusals go to stderr and return a nonzero exit status. Use `--help` for syntax.

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

`task create` saves the task and starts its worker. Pass an explicit `--harness`, `--account`, `--model`, `--effort`, `--mode`, `--fast` or `--rule` when required. The receipt includes the task ID and whether its worker started. A failed start keeps the task and names the blocker. Configure Hydras, projects, dispatch and view settings in the UI. Stop a foreground server with Ctrl+C. Use `/upgrade` in Hydra's chat to upgrade.

`send` addresses Hydra by default, or a task's worker with `--task`. Give `--text` or `--file <path|->`. Choose an `--idempotency-key` before the first attempt and reuse the same key and message if the receipt is lost. A queued receipt records acceptance for delivery.

`answer` records an answer to a saved question and routes it to Hydra or the task's worker according to who asked. Hydra can identify an owner's answer using `--from-message <id>`.

## Migrate from a Postgres installation

Stop the previous foreground server with Ctrl+C. If you installed its login service, note its port and run `setup --remove` with the old executable (`pnyx` or `pnyx-axi`) before rebuilding. Update and build the clone using the install steps in the README. Keep the old home and set `PNYX_HOME` to an empty folder before starting the new server. Existing data stays in the old installation. If you installed hooks, rerun `pnyx setup hooks` with the new home selected. Use `pnyx setup --port <previous-port>` to reinstall the login service at the same address.

## Reads during the storage cutover

The default home is `~/.pnyx`. Set `PNYX_HOME` to select another home. Records now live in `hydras/<hydra>/hydra.log`, `tasks/<task>/task.log` and `snapshot.json`. Workers append their assigned `worker.log`. The following transitional reads remain until the remaining command cleanup lands. These reads use plain text by default and accept `--json`.

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

`hydra check` returns an `epoch` beside `through`. Pass both as `--after <through> --epoch <epoch>` for the next check. A nonzero cursor without the current epoch expires; read without `--after` for fresh state after restart.

Only the assigned worker appends to its `worker.log`, one complete line per update:

```text
note: Investigated the failing flow
needs-you: Which of the two designs should I use?
blocked: The required account cannot sign in
link: https://example.com/result Result
done: Implemented and verified the requested behavior
```

A `note` updates the latest card line; running and idle come from the worker session. `needs-you` asks for a decision, `blocked` records an obstacle, `link` attaches a result, and `done` reports completion. Follow the task brief's landing rules before reporting done. Do not edit server-owned records.

The routine helper handles worker updates within the accepted instructions. Worker `done`, `needs-you` and `blocked` reports, finished findings, work ready for review, failures and owner questions go to Hydra, which tells you in your main chat in one plain line per outcome with full supplied links. Only chores the accepted instructions already cover, such as rerunning checks or answering an in-scope worker question, and unchanged waits stay quiet. Owner outcomes remain pending until Hydra finishes its turn.

## Isolated checks

Use a temporary `PNYX_HOME` for trials. When portless is installed, use `PNYX_HOME=<temporary-dir> portless <unique-name>.pnyx pnyx serve` and the URL it prints. Otherwise use `--port 0`. Setup changes hooks, skills or the login service beyond the selected home; use `--preview` to inspect those targets.
