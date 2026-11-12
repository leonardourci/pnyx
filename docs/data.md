# Data, privacy and uninstall

[Back to Pnyx](../README.md)

## Where data lives

Everything is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `server.json` and `server.lock` (the one running server: its pid, port and how it was started), `settings/events.jsonl` (the settings every Hydra shares), `logs/` (one file per UTC day of diagnostic lines, deleted past the days and size cap set under Settings > Logs), `harness-models.json`, the Claude Code and Codex model lists every Hydra's picker answers from while the server rereads them once in the background, and one folder per Hydra in `hydras/<hydra>/` with `events.jsonl` (the append-only log), `snapshot.json`, `harvest.json`, `children.json` (the agent processes the server runs, so the next start can stop any a crash left behind) and `copies/`, the task copies Pnyx made, plus `agent/` for Hydra’s own hosted session. Hydras from an older version move from `boards/<hydra>/` to `hydras/<hydra>/` on the first run, without overwriting or deleting anything: a Hydra that an older server still runs moves after that server stops, hook events spooled on either side are kept, a Hydra with task copies leaves a `boards/<hydra>` link to its new folder so the agents and git repositories using those copies keep their paths, and a Hydra found in both folders stops every command until one of the two is moved away. Existing Hydras keep their event vocabulary and service identities. Oracle keeps a private derived `oracle.db` beside each Hydra. Its first query ingests history once; later queries append only unread event and transcript lines, resetting only a replaced or truncated transcript. Normal catch-up never rebuilds the whole Hydra and runs no background indexing. An incompatible stored-text or tokenization change recreates this derived cache once. Event and native batches commit with their cursors, so interrupted searches resume completed progress. Old `search.db` files are unused and may be deleted. Snapshots from an older version rebuild from the unchanged event log. The CLI uses `hydra`, `--hydra` and `oracle`; old command names and flags have no aliases. Rerun `pnyx-axi setup hooks` and `pnyx-axi setup` after upgrading so installed hooks use `PNYX_HYDRA` and the `hydras/` folder, and one login service runs every Hydra. Restart agents started before upgrading so their hooks inherit `PNYX_HYDRA`; their recorded tasks and conversations remain in the log. Nothing at runtime writes inside the repository.

To start a Hydra over, first settle that Hydra's task copies with `pnyx-axi task copy <task> remove --hydra <hydra-id>`, then stop Pnyx with `pnyx-axi stop`. Remove only `<data-home>/hydras/<hydra-id>` for the selected Hydra: `<data-home>` is `$PNYX_HOME` when set, otherwise `~/.pnyx`. Run `git worktree prune` in each project that held that Hydra's copies afterward. Oracle needs no rebuild.

## Privacy

Pnyx stores task history, messages, attachments, project paths, saved memory and its diagnostic logs on your machine. Treat the Pnyx data folder and backups as private: transcript redaction does not make every message or attachment safe to publish. The local write token protects server writes; keep it private too.

Agents use the harness and provider you configure, so their prompts and tool results follow that provider's data policy. The GitHub integration contacts GitHub through `gh-axi`; Paseo and Firstmate use their configured local routes. Account configuration stores login folder paths rather than provider tokens.

## Uninstall

Remove the hooks first, since they point at the script in `~/.pnyx/hooks/`. Deleting `~/.pnyx` also deletes the task copies under each Hydra's folder, so settle them first:

```sh
pnyx-axi setup --remove  # if the login service was installed
pnyx-axi stop
pnyx-axi setup hooks --remove
pnyx-axi setup skills --remove
rm -rf ~/.pnyx
pnpm remove -g pnyx-axi
```
