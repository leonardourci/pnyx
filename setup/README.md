# setup

Hook scripts per harness, installed by `pnyx-axi setup hooks` into user-level settings. Installation keeps existing hook entries.

- `hooks/pnyx-hook.sh`: the silent reporting hook for Claude Code and Codex. When a session starts or takes a prompt it also records the session's terminal (TTY, process, and its tmux, Herdr, Paseo, iTerm2 or Terminal host), so replies from the board can be typed into it with nothing else to configure.
