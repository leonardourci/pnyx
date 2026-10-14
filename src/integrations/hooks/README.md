# hooks

Claude Code and Codex hooks as a source of cards.

- `setup/hooks/pnyx-hook.sh` is the hook itself, a POSIX shell script copied to `$PNYX_HOME/hooks/` by `pnyx-axi setup hooks`. It prints nothing, exits 0 every time and never waits on the network, a browser or a model. It wraps the harness payload in one JSON line (`{v, id, at, harness, event, payload}`) and writes it to the default board's server socket `$PNYX_HOME/boards/default/server.sock` (the server handles each line as soon as its newline arrives and replies nothing, so the hook never relies on nc half-closing) or, when no server is listening, straight to that board's spool. It passes on every event it is installed for and does no parsing; picking what the board needs from a payload happens in `pnyx-axi`.
- `observe.ts` turns a spooled payload into card observations, keyed `<harness>:<session id>` and `<harness>:<session id>/<agent id>` for subagents, with the parent, working folder and transcript path. Each event sets the card's activity and opens or closes its requests the way the agent's own interface would; the table below lists them. Every rule is fixed and reads only fields the harness sends: nothing is classified by a model, and hooks never record an outcome. A created pull request's URL becomes a link with no state, a hint to refresh it rather than proof. Claude Code's helper agents (an empty `agent_type`: session titles, prompt suggestions, compaction) get no card, since its own interface never shows them.
- `settings.ts` reads a session's settings from hook payloads and transcript records: model, effort, permission mode and fast mode under the same names for both harnesses, plus settings only one harness has (Claude Code's context window, Codex's approval policy, sandbox, collaboration mode and reasoning summary, and each one's client and version). `observe.ts` puts a payload's settings on the card; `harvest.ts` adds what the transcript gained and records only a change.
- `notes.ts` reads the notes a harness already wrote into a session transcript: Claude Code's compaction summaries, older summary records and session titles, each AskUserQuestion question with the user's answer, and Codex's readable compaction summaries (a remote compaction is encrypted and yields none). Nothing is generated.
- `harvest.ts` appends those notes to the session's card as `card.noted` events, each with an id derived from its card and source record, so a re-read appends nothing twice. It runs after a Stop, SubagentStop, PostCompact or SessionEnd event is ingested, and on `pnyx-axi harvest`. `harvest.json` in the board's folder remembers how far each transcript was read; deleting it costs one re-read, never a duplicate.
- `install.ts` merges Pnyx's entries into the user-level `settings.json` (Claude Code, `CLAUDE_CONFIG_DIR`) or `hooks.json` (Codex, `CODEX_HOME`), for every tool, keeping every other hook, and takes them out again with `--remove`. Rerunning it after an upgrade adds new events and replaces entries an older version installed. Codex asks to trust each new entry once through `/hooks`. No session-start board summary is installed.

## Events

A request is blocking unless marked otherwise; a blocking request puts the card in Needs you ahead of a linked pull request, and the others only ahead of ongoing work. Requests opened by hooks have keys starting with `hook:`, so clearing them never touches another source's.

| Event | Harness | Activity | Requests |
|---|---|---|---|
| SessionStart | both | started, resumed or compacted | clears all |
| UserPromptSubmit | both | working | clears all |
| PreToolUse, every tool | both | `running <tool>`, or the pull request or deploy command | AskUserQuestion opens its question, ExitPlanMode a plan to approve; clears idle and error |
| PermissionRequest | both | `waiting for permission: <tool>` | opens `Allow <tool>: <command or path>` (or the question or plan) |
| PermissionDenied | Claude Code | `<tool> denied` | closes that tool's request |
| PostToolUse | both | working, or `ran gh pr create` and the like | closes that tool's request, idle and error |
| PostToolUseFailure | Claude Code | `<tool> failed`, or interrupted | as PostToolUse |
| Notification `permission_prompt` | Claude Code | | opens its message unless a request is already open |
| Notification `agent_needs_input` | Claude Code | needs your input | opens its message |
| Notification `elicitation_dialog`, `elicitation_url_dialog` | Claude Code | | opens its message unless a request is already open |
| Notification `elicitation_complete`, `elicitation_response` | Claude Code | | closes the input request |
| Notification `idle_prompt` | Claude Code | idle, waiting for input | opens "waiting for your input", not blocking |
| Notification, other types | Claude Code | its message (`auth_success` is ignored) | |
| Elicitation | Claude Code | waiting for your input | opens `<server>: <message>` |
| ElicitationResult | Claude Code | working | closes the input request |
| SubagentStart, SubagentStop | both | started, stopped (on the child's card) | |
| TaskCreated, TaskCompleted | Claude Code | `task: <subject>`, `task done: <subject>` | |
| TeammateIdle | Claude Code | `teammate <name> idle` | |
| PreCompact, PostCompact | both | compacting, compacted | |
| Stop | both | idle, or `idle, N background tasks running` | clears all |
| StopFailure | Claude Code | `stopped on <error>` | clears all, opens `<error>: <details>`, not blocking |
| Interrupt | Codex | interrupted | clears all |
| SessionEnd | both | ended | clears all |

Left out on purpose, from the Claude Code reference: WorktreeCreate and WorktreeRemove (a command hook there replaces Claude Code's own git worktree handling), MessageDisplay (fires on every streamed chunk of text; the thread reader reads the transcript instead), PostToolBatch (repeats each PostToolUse), Pre/PostModelSwitch (session settings, not activity), and Setup, UserPromptExpansion, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded and FileChanged (environment changes the interface does not show as agent state; every payload already carries the working folder).

Codex's session rollout records turns (`task_started`, `task_complete`), interruptions (`turn_aborted`), compactions and tool calls, all of which the Codex hooks above already report; it does not record approval prompts, so the PermissionRequest hook is the only source for those.
