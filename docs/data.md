# Data, privacy and uninstall

[Back to Pnyx](../README.md)

## Where data lives

Each Hydra's events, tasks, questions, declarations, links, notes and messages are in Postgres, in the home's own database (`pnyx` for `~/.pnyx`, a name derived from the path for any other home). A Hydra kept in `hydras/<hydra>/events.jsonl` by an older version is imported in one transaction the first time it is read; copies of agent transcripts in it stay out, and the file is left as it was, as a backup. Everything else is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `server.json` and `server.lock` (the one running server: its pid, port and how it was started), `settings/events.jsonl` (the settings every Hydra shares), `logs/` (one file per UTC day of diagnostic lines, deleted past the days and size cap set under Settings > Logs), `zero/` (zero-cache's replica of the Postgres database), `harness-models.json`, the Claude Code and Codex model lists every Hydra's picker answers from while the server rereads them once in the background, and one folder per Hydra in `hydras/<hydra>/` with `oracle.db` (the derived Oracle cache), `harvest.json`, `children.json` (the agent processes the server runs, so the next start can stop any a crash left behind) and `copies/`, the task copies Pnyx made, plus `agent/` for Hydra’s own hosted session. Hydras from an older version move from `boards/<hydra>/` to `hydras/<hydra>/` on the first run, without overwriting or deleting anything: a Hydra that an older server still runs moves after that server stops, hook events spooled on either side are kept, a Hydra with task copies leaves a `boards/<hydra>` link to its new folder so the agents and git repositories using those copies keep their paths, and a Hydra found in both folders stops every command until one of the two is moved away. Existing Hydras keep their event vocabulary and service identities. A Hydra's first Oracle query deletes the retired `search.db` and its WAL and shared-memory files; the derived `oracle.db` is rebuilt once when its version changes or its event log is restored or replaced. The CLI uses `hydra`, `--hydra` and `oracle`; old command names and flags have no aliases. Rerun `pnyx-axi setup hooks` and `pnyx-axi setup` after upgrading so installed hooks use `PNYX_HYDRA` and the `hydras/` folder, and one login service runs every Hydra. Restart agents started before upgrading so their hooks inherit `PNYX_HYDRA`; their recorded tasks and conversations remain in the log. Nothing at runtime writes inside the repository.

To start a Hydra over, first settle that Hydra's task copies with `pnyx-axi task copy <task> remove --hydra <hydra-id>`, then stop Pnyx with `pnyx-axi stop`. Delete its rows with `psql -d <database> -c "delete from hydras where id = '<hydra-id>'"`, which removes everything Postgres holds for it (`pnyx-axi setup postgres --check` names the home's database), and remove only `<data-home>/hydras/<hydra-id>`: `<data-home>` is `$PNYX_HOME` when set, otherwise `~/.pnyx`. Removing the folder alone resets nothing. Run `git worktree prune` in each project that held that Hydra's copies afterward.

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
