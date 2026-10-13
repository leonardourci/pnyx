# hooks

Claude Code and Codex hooks as a source of cards.

- `setup/hooks/pnyx-hook.sh` is the hook itself, a POSIX shell script copied to `$PNYX_HOME/hooks/` by `pnyx-axi setup hooks`. It prints nothing, exits 0 every time and never waits on the network, a browser or a model. It wraps the harness payload in one JSON line (`{v, id, at, harness, event, payload}`) and writes it to the service socket `$PNYX_HOME/pnyx.sock` (one line per connection; the service closes it after reading) or, when no service is listening, to the default board's spool. Tool hooks pass on only `gh pr create`, `gh pr merge` (or their `gh-axi` forms) and deploy commands.
- `observe.ts` turns a spooled payload into card observations, keyed `<harness>:<session id>` and `<harness>:<session id>/<agent id>` for subagents, with the parent, working folder and transcript path. Activity comes from the event (started, working, idle, ended); hooks never record an outcome. A created pull request's URL becomes a link with no state, a hint to refresh it rather than proof.
- `install.ts` merges Pnyx's entries into the user-level `settings.json` (Claude Code, `CLAUDE_CONFIG_DIR`) or `hooks.json` (Codex, `CODEX_HOME`), keeping every other hook, and takes them out again with `--remove`. No session-start board summary is installed.
