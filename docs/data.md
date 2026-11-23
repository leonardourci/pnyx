# Data, privacy and uninstall

[Back to Othrys](../README.md)

## Where data lives

Task copies are allocated under `<data-home>/copies/`, shared by every Titan. Copy reuse checks task and session ownership across the home, so a Titan cannot reuse another Titan’s attached checkout. Existing recorded copy paths stay where they are.

Native workers keep their runtime files in `<data-home>/runtime/tasks/<task-id>/`: `worker.log` is the worker’s append-only report, and `children.json` records its process groups for restart recovery and cleanup. Moving a task to another Titan preserves its native session, pending permission, compaction inputs and runtime folder. The worker’s captured Titan environment resolves to its current Titan when it calls the CLI. Removing the source Titan leaves the moved worker running; closing it or removing the destination stops its tools. Tasks can move during compaction and while messages are held. A worker that is still starting must finish startup before moving.

Worker reports are folded in batches of at most 64 KiB and 128 lines, with the cursor committed after each batch. Catch-up continues without another append. A line longer than 16 KiB produces a visible warning and is discarded through its next newline; the discard cursor survives restart, and the following valid line is processed normally.

Each Titan saves authored decisions and owner words in `hydras/<hydra>/hydra.log`. Each task owns `hydras/<hydra>/tasks/<task>/task.log`, `worker.log` and derived `brief.md`. Task folders determine membership: moving a task renames its folder, retaining the complete task log. Stable hard links under `runtime/tasks/<task>/` keep the worker’s captured report and read paths working across that move. Copies remain under `copies/`.

Only the daemon writes canonical state. It applies commands through one ordered queue, appends their meaningful facts and syncs the files before returning success. Native IDs make uncertain receipts safe to retry. Each file has its own line number; browser cursors use an in-memory epoch and sequence. Five-minute snapshots, written only after changes, and clean-stop snapshots cache state and byte positions for restart. A snapshot is disposable: the logs remain authoritative. See [file recovery and receipts](file-store.md).

Hook activity, transcript metadata, delivery and helper progress and project refreshes update memory without adding history facts. A session first seen outside Othrys saves its source binding (provider, session ID and transcript path) when that binding is learned or changes; the consumed hook spool is its only source for those pointers. Restart rereads the native files to rebuild observations. Worker reports retain the consumed file identity and byte cursor, so truncation is visible and replacement reports start from their own cursor.

Shared settings, dispatch configuration, project memory and owner memory keep their separate local files. The home also contains hooks, its local authentication token, `server.json`, the daemon’s `server.lock`, diagnostic files and provider model catalogs. Each Titan keeps a derived `oracle.db`, transcript cursors, process records, handoffs and its hosted agent folder. Oracle is a disposable index over saved task decisions and notes; it does not own state. Nothing at runtime writes inside the repository.

This release uses a fresh empty `OTHRYS_HOME`. It does not import old Postgres databases or legacy event files, and it does not delete existing data. Keep the previous home as a backup when changing versions. Older builds cannot read native task logs.

Agent conversations are read from each agent’s native transcripts. If a harness deletes those files, its side of the conversation goes with them; Othrys keeps the owner’s saved messages, decisions and worker reports.

Remove a Titan through the UI so its task copies and running work are settled before removal.

## Privacy

Othrys stores task history, messages, attachments, project paths, saved memory and its diagnostic logs on your machine. Treat the Othrys data folder and backups as private: transcript redaction does not make every message or attachment safe to publish. The local write token protects server writes; keep it private too.

Agents use the harness and provider you configure, so their prompts and tool results follow that provider's data policy. The GitHub integration contacts GitHub through `gh-axi`. Account configuration stores login folder paths rather than provider tokens.

## Uninstall

Select the installation's home before removing its login service or hooks. For a custom home, export its `OTHRYS_HOME` and add `--allow-custom-home` to the setup commands. Stop the server and settle any task copies before deleting the selected home. The default home is `~/.othrys` and may hold your previous installation.

```sh
othrys setup --remove  # if the login service was installed
# Stop a foreground server with Ctrl+C.
othrys setup hooks --remove
othrys setup skills --remove
pnpm remove -g othrys
```
