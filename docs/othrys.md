# Othrys command line

The `othrys` command handles immediate actions. Output is plain text by default. Add `--json` for scripts. Successful receipts go to stdout. Refusals go to stderr and return a nonzero exit status. Use `--help` for syntax.

```sh
othrys serve --titan work
othrys setup --preview
othrys setup check
othrys debug health --titan work --json
othrys board --titan work
othrys task ack <task> <instruction-id> --session <session> --generation '<native-reference>' --titan work
othrys task create --title "Fix the empty state" --brief "Implement and check the empty state" --project app --titan work
othrys send --text "Review the open work" --titan work
othrys send --task <task> --text "Also check mobile" --titan work
othrys answer <task> <question> --text "Use the existing design" --titan work
```

`task create` saves the task and starts its worker. Pass an explicit `--harness`, `--account`, `--model`, `--effort`, `--mode`, `--fast` or `--rule` when required. The receipt includes the task ID and whether its worker started. A failed start keeps the task and names the blocker. Configure Titans, projects, dispatch and view settings in the UI. Stop a foreground server with Ctrl+C. Use `/upgrade` in Titan's chat to upgrade.

`send` addresses Titan by default, or a task's worker with `--task`. Give `--text` or `--file <path|->`. Choose an `--idempotency-key` before the first attempt and reuse the same key and message if the receipt is lost. A queued receipt records acceptance for delivery.

`answer` records an answer to a saved question and routes it to Titan or the task's worker according to who asked. Titan can identify an owner's answer using `--from-message <id>`.

`task ack` is an acknowledgement-only action for the assigned worker, after it reads the full instruction in its task record. Pass one exact instruction ID and copy the session and native generation reference from the notice or record. The same ID and assignment can be retried after a lost reply or server restart. A different task, worker launch or assignment is refused. It records read receipt only; it does not complete work, approve permissions or infer that a terminal injection succeeded. Hosted native input confirmations continue to record their own receipts. ID-only retries remain ID-only.

## Migrate from a Postgres installation

Stop the previous foreground server with Ctrl+C. If you installed its login service, note its port and run `setup --remove` with the old executable (`pnyx` or `pnyx-axi`) before rebuilding. Select the old installation's home for removal and add `--allow-custom-home` if it uses a custom home. Update and build the clone using the install steps in the README. Keep the old home and set `OTHRYS_HOME` to an empty folder before starting the new server. Existing data stays in the old installation. If you installed hooks, run `othrys setup hooks --allow-custom-home` with the new home selected. Use `othrys setup --allow-custom-home --port <previous-port>` to reinstall the login service at the same address.

## Read records and report through files

The default home is `~/.othrys`. Set `OTHRYS_HOME` to select another home. Each Titan has `hydras/<hydra>/hydra.log`, an optional `snapshot.json`, and a `tasks/<task>/` folder containing `task.log` and `worker.log`. Read these files directly with your harness's file tools. Logs are authoritative; the snapshot is a cached view and may be older or absent. Each native log numbers its own lines, so keep record IDs with their file scope rather than treating a line number as a global cursor. Follow recorded transcript paths for complete agent replies.

The CLI has no read, history, status, inbox or report commands. Use the UI for configuration and task edits. Reconcile saved instructions and delivery receipts before retrying a send; reading a file does not acknowledge or complete work.

Only the assigned worker appends to its `worker.log`, one complete line per update:

```text
note: Investigated the failing flow
needs-you: Which of the two designs should I use?
blocked: The required account cannot sign in
link: https://example.com/result Result
done: Implemented and verified the requested behavior
```

A `note` updates the latest card line; running and idle come from the worker session. `needs-you` asks for a decision, `blocked` records an obstacle, `link` attaches a result, and `done` reports completion. Follow the task brief's landing rules before reporting done. Do not edit server-owned records.

The routine helper handles worker updates within the accepted instructions. Worker `done`, `needs-you` and `blocked` reports, finished findings, work ready for review, failures and owner questions go to Titan, which tells you in your main chat in one plain line per outcome with full supplied links. Only chores the accepted instructions already cover, such as rerunning checks or answering an in-scope worker question, and unchanged waits stay quiet. Owner outcomes remain pending until Titan finishes its turn.

## Isolated checks

Use a temporary `OTHRYS_HOME` for trials. When portless is installed, use `OTHRYS_HOME=<temporary-dir> portless <unique-name>.othrys othrys serve` and the URL it prints. Otherwise use `--port 0`. Setup changes hooks, skills or the login service beyond the selected home; use `--preview` to inspect those targets.
