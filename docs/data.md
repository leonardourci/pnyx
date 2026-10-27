# Data, privacy and uninstall

[Back to Pnyx](../README.md)

## Where data lives

Everything is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `settings.json`, the semantic search models in `models/` with the worker's `semantic.log`, `harness-models.json`, the Claude Code and Codex model lists every Hydra's picker answers from while the server rereads them once in the background, and one folder per Hydra in `hydras/<hydra>/` with `events.jsonl` (the append-only log), `snapshot.json`, `search.db`, `harvest.json` and `copies/`, the task copies Pnyx made, plus `agent/` for Hydra’s own hosted session. Hydras from an older version move from `boards/<hydra>/` to `hydras/<hydra>/` on the first run, without overwriting or deleting anything: a Hydra that an older server still runs moves after that server stops, hook events spooled on either side are kept, a Hydra with task copies leaves a `boards/<hydra>` link to its new folder so the agents and git repositories using those copies keep their paths, and a Hydra found in both folders stops every command until one of the two is moved away. Existing Hydras keep their `search.db` caches and event vocabulary, saved search settings and service identities. Snapshots from an older version rebuild from the unchanged event log. The CLI uses `hydra`, `--hydra` and `oracle`; old command names and flags have no aliases. Rerun `pnyx-axi setup hooks` and `pnyx-axi setup service` after upgrading so installed hooks use `PNYX_HYDRA` and the `hydras/` folder, and one login service runs every Hydra. Restart agents started before upgrading so their hooks inherit `PNYX_HYDRA`; their recorded tasks and conversations remain in the log. Nothing at runtime writes inside the repository.

To start a Hydra over, stop the server and delete its folder: `pnyx-axi stop && rm -rf ~/.pnyx/hydras/default`. That folder also holds its task copies, so settle them first with `pnyx-axi task copy <task> remove`, and run `git worktree prune` in each project afterwards. `pnyx-axi oracle rebuild` rebuilds only the search index.

## Privacy

Pnyx stores task history, messages, attachments, project paths and saved memory on your machine. Treat the Pnyx data folder and backups as private: transcript redaction does not make every message or attachment safe to publish. The local write token protects server writes; keep it private too.

Oracle's semantic models run locally and download on first use. See [semantic search](cli.md#skip-semantic-search) for download sizes and how to disable it. Agents use the harness and provider you configure, so their prompts and tool results follow that provider's data policy. The GitHub integration contacts GitHub through `gh-axi`; Paseo and Firstmate use their configured local routes. Account configuration stores login folder paths rather than provider tokens.

## Uninstall

Remove the hooks first, since they point at the script in `~/.pnyx/hooks/`. Deleting `~/.pnyx` also deletes the task copies under each Hydra's folder, so settle them first:

```sh
pnyx-axi setup service --remove  # macOS, if the login service was installed
pnyx-axi stop
pnyx-axi setup hooks --remove
pnyx-axi setup skills --remove
rm -rf ~/.pnyx
pnpm remove -g pnyx-axi
```
