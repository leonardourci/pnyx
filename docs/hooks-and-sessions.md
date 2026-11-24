# Hooks and sessions

[Back to Othrys](../README.md)

## Add your agents

```sh
othrys setup hooks                    # Claude Code and Codex, whichever config folder exists
othrys setup hooks --harness codex    # just one
othrys setup hooks --preview          # show what would change
othrys setup hooks --remove           # take Othrys's hooks out again
```

This adds a reporting hook to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored), keeping every other hook. It prints nothing, except at session start in a folder inside an attached project, where it gives the new session that project's open tasks. Hooks record sessions for explicit attachment and watch one thing in each: whether the agent is working on a turn (from a prompt or tool call) or finished it (Claude Code's and Codex's Stop hook), shown as a small indicator on the card. For a session Othrys runs itself, the working and finished state comes from Othrys, which starts and ends each turn; that session's hooks never change it, because they can arrive late or out of order. A repeated report advances a private source timestamp without adding an event or syncing a row to the page. Raw reports go to the diagnostic log through bounded asynchronous appends. Changes to task state remain events. The same holds for any push with a `source`, such as Othrys's own. Ad-hoc sessions never create tasks; sessions without an interactive terminal stay in recorded history. Each interactive session records the terminal it runs in so the Titan can type your replies into it: a tmux pane, a Herdr pane, or an iTerm2 or Terminal window (macOS asks once to let Othrys control that app; the answer lives under System Settings > Privacy & Security > Automation). A task without a reply route reports a delivery error; failed CLI sends retain their recorded delivery state. Already had the hooks installed? Re-run `othrys setup hooks` to enable typing into sessions. Codex asks you to review and trust new hooks once: run `/hooks` in Codex after installing. Rerun `othrys setup hooks` after upgrading Othrys so the hooks cover the events the new version reads.

## Sessions and reply routes

Attach a recorded session to a task in the UI. Inspect it in the UI or read its `task.log` and recorded transcript files and send a reply with `othrys send --task <task> --text "<message>" --titan <id>`. See [Provider sessions](provider-sessions.md) for hosted conversations and [Data and privacy](data.md) for retention.
