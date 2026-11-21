# Data, privacy and uninstall

[Back to Pnyx](../README.md)

## Where data lives

Task copies are allocated under `<data-home>/copies/`, shared by every Hydra. Copy reuse checks task and session ownership across the home, so a Hydra cannot reuse another Hydra’s attached checkout. Existing recorded copy paths stay where they are.

Native workers keep their runtime files in `<data-home>/runtime/tasks/<task-id>/`: `worker.log` is the worker’s append-only report, and `children.json` records its process groups for restart recovery and cleanup. Moving a task to another Hydra preserves its native session, pending permission, compaction inputs and runtime folder. The worker’s captured Hydra environment resolves to its current Hydra when it calls the CLI. Removing the source Hydra leaves the moved worker running; closing it or removing the destination stops its tools. A move waits until a worker has finished starting or handing off held input.

Worker reports are folded in batches of at most 64 KiB and 128 lines, with the cursor committed after each batch. Catch-up continues without another append. A line longer than 16 KiB produces a visible warning and is discarded through its next newline; the discard cursor survives restart, and the following valid line is processed normally.

Each Hydra's events, tasks, questions, declarations, links, notes and messages are in Postgres, in the home's own database (`pnyx` for `~/.pnyx`, a name derived from the path for any other home). A Hydra kept in `hydras/<hydra>/events.jsonl` by an older version is imported in one transaction when the server first serves it, and other commands answer `NOT_IMPORTED` until then; transcript copies an older version saved in it are not imported, and the file is left as it was, as a backup. Changing the `postgresUrl` setting or moving the home to another path moves no data: Pnyx then opens an empty database, and the server imports any `events.jsonl` backups still in the home again, as if they were current. Everything else is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `server.json` and `server.lock` (the one running server: its pid, port and how it was started), `settings/events.jsonl` (the settings every Hydra shares), `logs/` (one file per UTC day of diagnostic lines, deleted past the days and size cap set under Settings > Logs), `harness-models.json`, the Claude Code and Codex model lists every Hydra's picker answers from while the server rereads them once in the background, and one folder per Hydra in `hydras/<hydra>/` with `oracle.db` (the derived Oracle cache), `harvest.json` (how far each transcript's notes were read), `children.json` (the agent processes the server runs, so the next start can stop any a crash left behind), `handoffs/` (a queued worker's branch switch in progress, so the next start can restore or keep its checkout) and `agent/` for Hydra’s own hosted session. Hydras from an older version move from `boards/<hydra>/` to `hydras/<hydra>/` on the first run, without overwriting or deleting anything: a Hydra that an older server still runs moves after that server stops, hook events spooled on either side are kept, a Hydra with task copies leaves a `boards/<hydra>` link to its new folder so the agents and git repositories using those copies keep their paths, and a Hydra found in both folders stops every command until one of the two is moved away. Existing Hydras keep their event vocabulary and service identities. A Hydra's first Oracle query deletes the retired `search.db` and its WAL and shared-memory files; the derived `oracle.db` is rebuilt once when its version changes or its Hydra is restored or replaced. The CLI uses `hydra`, `--hydra` and `oracle`; old command names and flags have no aliases. Rerun `pnyx setup hooks` and `pnyx setup` after upgrading so installed hooks use `PNYX_HYDRA` and the `hydras/` folder, and one login service runs every Hydra. Restart agents started before upgrading so their hooks inherit `PNYX_HYDRA`; their recorded tasks remain in the log. Nothing at runtime writes inside the repository.

Event history keeps task creation, authored edits, briefs, owner words, questions, decisions, worker reports and links. Hook activity, transcript metadata, delivery and helper progress, automatic lifecycle moves and project refreshes update the daemon’s current state and read rows without appending history events. The daemon keeps recent changes in memory for live updates. Restart recovery reads the current rows, including native turn boundaries and resume counts; inscribe receipts stay with their milestones so retrying a completed pass remains a duplicate.

Agent conversations are read from each agent's own native transcript, never copied. An agent may delete its native transcripts after its own retention period (Claude Code: 30 days without activity, by default), and its side of those conversations goes with them; Pnyx keeps the owner's messages, their receipts and the cards' data. Rolling back to a build from before Postgres reads each Hydra's `events.jsonl` as it was at the import and misses every change made since, and a build that still copied transcripts backfills them again from their start; once that build appends to the log, the newer build refuses the Hydra with `LOG_CHANGED`.

To start a Hydra over, first settle that Hydra's task copies in the UI, then stop the foreground server with Ctrl+C or remove its login service with `pnyx setup --remove`. Delete its rows with `psql -d <database> -c "delete from hydras where id = '<hydra-id>'"`, which removes everything Postgres holds for it (`pnyx setup postgres --check` names the home's database), and remove only `<data-home>/hydras/<hydra-id>`: `<data-home>` is `$PNYX_HOME` when set, otherwise `~/.pnyx`. Removing the folder alone resets nothing. Run `git worktree prune` in each project that held that Hydra's copies afterward.

## Privacy

Pnyx stores task history, messages, attachments, project paths, saved memory and its diagnostic logs on your machine. Treat the Pnyx data folder and backups as private: transcript redaction does not make every message or attachment safe to publish. The local write token protects server writes; keep it private too.

Agents use the harness and provider you configure, so their prompts and tool results follow that provider's data policy. The GitHub integration contacts GitHub through `gh-axi`. Account configuration stores login folder paths rather than provider tokens.

## Uninstall

Remove the hooks first, since they point at the script in `~/.pnyx/hooks/`. Deleting `~/.pnyx` also deletes the task copies under `~/.pnyx/copies/`, so settle them first:

```sh
pnyx setup --remove  # if the login service was installed
# Stop a foreground server with Ctrl+C.
pnyx setup hooks --remove
pnyx setup skills --remove
rm -rf ~/.pnyx
pnpm remove -g pnyx
```

A legacy import refuses an incomplete final line with `TORN_TAIL` and its byte count. Repair the line from a backup before retrying. Event inserts use bounded batches inside the same transaction. During startup, the server records verified progress as it replays and saves the import; restart extends its readiness wait while that progress advances and still times out when it stalls.

A write detaches an object assigned across different row owners, such as a card and a session, so a later change cannot silently alter an unrelated saved row. Cross-Hydra moves claim both sequences and commit both sides in one transaction.
