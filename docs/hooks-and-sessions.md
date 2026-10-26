# Hooks and sessions

[Back to Pnyx](../README.md)

## Add your agents

```sh
pnyx-axi setup hooks                    # Claude Code and Codex, whichever config folder exists
pnyx-axi setup hooks --harness codex    # just one
pnyx-axi setup hooks --preview          # show what would change
pnyx-axi setup hooks --remove           # take Pnyx's hooks out again
```

This adds a silent reporting hook to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored), keeping every other hook.
Hooks record sessions for explicit attachment and watch one thing in each, as Paseo does: whether the agent is working on a turn (from a prompt or tool call) or finished it (Claude Code's and Codex's Stop hook), shown as a small indicator on the card.
Ad-hoc sessions never create tasks; sessions without an interactive terminal stay in recorded history.
Each interactive session records the terminal it runs in so the Hydra can type your replies into it: a tmux pane, a Herdr pane, a Paseo terminal, or an iTerm2 or Terminal window (macOS asks once to let Pnyx control that app; the answer lives under System Settings > Privacy & Security > Automation).
A task without a reply route reports a delivery error; failed CLI sends retain their recorded delivery state.
Already had the hooks installed?
Re-run `pnyx-axi setup hooks` to enable typing into sessions.
Codex asks you to review and trust new hooks once: run `/hooks` in Codex after installing.
Rerun `pnyx-axi setup hooks` after upgrading Pnyx so the hooks cover the events the new version reads.

## Sessions and reply routes

Hooks record existing sessions; they do not create tasks automatically.
Attach one explicitly with `pnyx-axi task attach <task> --session <session> --hydra <id>`.
Use `pnyx-axi history` to find recorded sessions and `pnyx-axi reply <task> --text "<message>" --hydra <id>` to send a reply.

For agents started by Pnyx, Paseo or a configured command, see [Starting workers and Hydra](cli.md#starting-workers-and-hydra).
The [Firstmate integration](firstmate.md) uses Firstmate's own reply and inbox commands.
Conversation retention and steering inboxes are covered in [Task records](cli.md#task-records).
