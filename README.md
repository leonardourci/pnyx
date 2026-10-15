# Pnyx

Pnyx is the app, each board is a **Hydra**, and search is the **Oracle**. Everything else uses its plain name.

Pnyx tracks explicit tasks in Hydras, each an orchestrator and its tasks. Create tasks and columns inline, attach an interactive agent session, and continue its conversation from the card. Ad-hoc agent sessions stay in History without creating tasks.

A deterministic view of every agent and its work, with an [AXI](https://axi.md/) CLI named `pnyx-axi`.

Pnyx records tasks, attaches one agent session to each task, and queues your replies to that session. It is a view over the tools you already use, not an orchestrator: Claude Code and Codex hooks report sessions, a Firstmate integration reads Firstmate's own records, and linked pull requests come from GitHub. Every change is an event in an append-only log, so the Hydra can be replayed and audited. Pre-v1.

![Pnyx demo](docs/media/demo.gif)

The demo uses a synthetic fixture Hydra. It shows `pnyx-axi setup hooks`, `pnyx-axi serve --home`, the four-column Hydra, a card opened on its conversation, a card moved with `m`, a history search with `/`, and `pnyx-axi stop` plus `pnyx-axi setup hooks --remove`.

## Install

Needs Node 22.13 or newer and pnpm (the version pinned in `package.json`).

```sh
git clone https://github.com/leonardourci/pnyx.git
cd pnyx
pnpm install
pnpm run build
pnpm add -g "$PWD"
pnyx-axi --version
```

`pnpm add -g` links the clone, so after a `git pull` you only rerun `pnpm install && pnpm run build`. `pnpm link --global` does not work with this pnpm; use `pnpm add -g "$PWD"` (or `npm install -g .`). Without a global install, run `./dist/cli/pnyx-axi.js` from the clone.

## Run

```sh
pnyx-axi serve
```

One server runs every Hydra in the Pnyx data folder (`~/.pnyx`, or `PNYX_HOME`): one port, each Hydra at its own path, http://127.0.0.1:4747/hydra/<id>/, with http://127.0.0.1:4747 opening the default Hydra. Open the `url` it prints; `--port` picks another port, and if that port is taken, `serve` exits with `PORT_IN_USE` rather than picking another. The Hydra menu in the top bar switches between Hydras on the same server, and a Hydra created while the server runs is served as soon as its folder appears. A Hydra that fails to load is skipped and reported (in the `serve` output and at `/health`), and the others keep working. Each Hydra keeps its own hook socket, its linked Firstmate home and the agents Pnyx started for it, all inside that one process. `pnyx-axi` with no arguments shows the Hydra summary and the running server's address. Stop a foreground server with Ctrl+C or `pnyx-axi stop`, which stops the server of every Hydra. The login service uses the Node executable and Pnyx installation that ran setup, reaching Node through a link on `PATH` such as `/opt/homebrew/bin/node` when one points to it, so a Homebrew upgrade keeps the service starting; keep that installation in place and rerun setup after moving it or switching Node. Rerunning setup on a running service replaces it in place: it waits for launchd to finish stopping the old job before starting the new one. Each Hydra permits one server even when two starts race. A service-managed server restarts after `stop`; use `setup service --remove` to keep it stopped.

The browser reconnects automatically with capped backoff and a heartbeat, resumes Hydra events and restores the open conversation subscription. Composers stay usable during an outage; submitting a message keeps its draft and sends it when the connection returns, using the same delivery key on retries. A failed send leaves one short line in the conversation. The top-bar mark is the connection indicator. Session identities and attachments live in the event log and survive browser reloads and server restarts.

When the server restarts on a new build at the same port, an open Hydra reloads itself and keeps the open card, unsent drafts and scroll position.

To keep it running in the background:

```sh
mkdir -p ~/.pnyx
pnyx-axi setup service                     # macOS: start now and at login, restart after exit
pnyx-axi setup service --port 4748         # on another port
pnyx-axi setup service --preview           # inspect the launchd configuration
pnyx-axi setup service --remove            # stop and uninstall the service
```

There is one login service for every Hydra. Setting it up replaces the one-per-Hydra services older versions installed for the same data folder.

## Add your agents

```sh
pnyx-axi setup hooks                    # Claude Code and Codex, whichever config folder exists
pnyx-axi setup hooks --harness codex    # just one
pnyx-axi setup hooks --preview          # show what would change
pnyx-axi setup hooks --remove           # take Pnyx's hooks out again
```

This adds a silent reporting hook to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored), keeping every other hook. Hooks record sessions for explicit attachment and watch one thing in each, as Paseo does: whether the agent is working on a turn (from a prompt or tool call) or finished it (Claude Code's and Codex's Stop hook), shown as a small indicator on the card. Ad-hoc sessions never create tasks; sessions without an interactive terminal stay in History. Each interactive session records the terminal it runs in so the Hydra can type your replies into it: a tmux pane, a Herdr pane, a Paseo terminal, or an iTerm2 or Terminal window (macOS asks once to let Pnyx control that app; the answer lives under System Settings > Privacy & Security > Automation). A task without a reply route keeps its draft; failed sends show a short line in the conversation. Already had the hooks installed? Re-run `pnyx-axi setup hooks` to enable typing into sessions. Codex asks you to review and trust new hooks once: run `/hooks` in Codex after installing. Rerun `pnyx-axi setup hooks` after upgrading Pnyx so the hooks cover the events the new version reads.

## Firstmate

Each Firstmate home gets its own Hydra. `pnyx-axi hydra homes` lists the homes beside each other, as `new-firstmate` makes them (in `FIRSTMATE_FACTORY_BASE`, by default `~/projects/agentic-engineering-workflow`; `--base` picks another folder), and the Hydra each one has; `pnyx-axi hydra create --firstmate <home>` creates a Hydra named after the home. `pnyx-axi setup hydra --home <home> --hydra <id>` makes the home that Hydra: it copies the `pnyx-hydra` skill into the home's `.agents/skills/` as a local skill (listed in the clone's `.git/info/exclude`, so Firstmate's tracked files never change) and leaves Firstmate an inbox note pointing at it. A Hydra run by a Firstmate home watches that home when served, without `--home`.

`serve --hydra <id> --home <home>` uses a home that Hydra has not recorded; a Hydra mirrors one Firstmate home, and `serve`, `firstmate sync` and `firstmate watch` name any other home they ignore. The server watches the home's `state/` and `data/` folders, turns each task into a card, and sends your replies through the home's own `bin/fm-send.sh`. Apart from `setup hydra` adding its local skill, it only reads the home. Without a server, `pnyx-axi firstmate sync --home <path>` folds a home in once and `pnyx-axi firstmate watch --home <path>` keeps doing so; `pnyx-axi reply <id> --text <text> --home <path>` replies from the terminal. The first interactive Claude Code or Codex session in an open task's worktree joins that task; a later session in the same folder stays unassigned. The managed task keeps replying through Firstmate. A setting change from a task card's Agent tab goes to the orchestrator as a request note through the home's `bin/fm-inbox.sh note --request-id <id>`, with the same request id retained on retries. When Firstmate records a Paseo terminal, only sessions in that terminal can join or replace its worker; a replacement on the same terminal continues the task while earlier sessions remain in History.

## Task records

Hydra can be Firstmate or an ordinary agent session. Each Hydra has one orchestrator identity, and each explicit task has zero or one attached worker. Tasks support one level of subtasks. Pnyx records work and queues messages; Hydra decides what to do and dispatches workers. Changing Hydra preserves tasks, earlier worker attachments and messages to previous Hydras.

Use `hydra create|set|show|list` for Hydras, `column create|rename|describe|resize|delete|reorder|list` for their columns, and `task create|brief|hide|unhide|rename|status|list|show|history|chat` for work records. `task create --parent <task>` creates a subtask. Creating a task in a role column records that role's initial status. The owner arranges cards, and Hydra may place one in response to its own agent doing something that calls for it, guided by the column descriptions. A status declaration alone never moves a card; `move <task> <column> [--before <task>]` (or dragging the card) sets both. `column delete <id> --to <column>` moves every task in the deleted column to `--to` (the first remaining column by default), and Undo refuses to overwrite later edits. The final column cannot be deleted. CLI card moves, column reorders and column deletes first return `confirmation: needed` with a token and a summary; repeat the exact command with `--confirm <token>` to act. A changed target invalidates the token. Browser gestures act directly on the owner’s instruction. Hydra’s own changes (writes with actor `hydra`) through `move`, `task create|brief|hide|unhide` and `task start` must carry one short `--reason "<why>"`. Pnyx stores it on the event, shows it in the task’s history and posts one line in Hydra’s chat built from the action and the reason, such as “Moved API cleanup to Needs you: its agent asked which schema to use”; the command returns that line as `posted`. An optional `--details "<more context>"` appears under the line. The owner’s own moves and edits need no reason.

Create a task with `task create --title "<title>" --brief "<instructions>"` and edit its brief with `task brief <task> --brief "<instructions>"` (empty text clears it). Starts include the brief in the opening prompt, whether Pnyx runs the agent or it starts through Paseo, Firstmate or the configured command. An explicit `task attach` sends it through the attached agent’s reply route once per attachment; the attachment receipt includes its delivery result. `task hide <task>` removes work from the live Hydra and `task unhide <task>` restores it; both are events and preserve all history.

Columns carry a description of what belongs in them, available through `column list` and set with `column create --description "<when and why>"` or `column describe <id> --description "<when and why>"`. `column resize <id> --width <pixels>` and `hydra resize --width <pixels>` persist widths. `layout show` reports overrides and stored defaults (290 pixels per column, 360 for Hydra); `layout reset` restores those widths while preserving other preferences.

Hydra’s memory is available through `hydra memory list`, `hydra memory set --key <short-name> --text "<fact and why>"` and `hydra memory forget --key <short-name>`. Entries replace by key, survive a Hydra switch and remain isolated to their Hydra; all replacements and removals stay in the event log. Hydra reads memory at startup and stows concise lasting facts before a context reset.

A task's status is an explicit declaration (working, needs_you, paused, blocked or done) shown on its card; neither a declaration nor a merged pull request moves the card. Silence, finished turns and session exit do not complete tasks. Firstmate's backlog, status text and worker metadata are mirrored into retained task records, including backlog items without workers. A Hydra stops mirroring a home when that home no longer runs it.

The append-only log preserves Hydra, task, subtask, session, command and message identities. Replaying existing events migrates old session records without changing their event bytes or ids. Unattached and headless sessions remain available in History and search. Harvested user and assistant messages are redacted and copied into the log on turn end, attachment changes and explicit `harvest`, so observed conversations remain readable and searchable after a native transcript disappears. Oracle remains a derived, deletable index.

`hydra send --text <message>` queues a Hydra-level message with no task. `hydra send --task <task> [--action send|worker]` queues a task-specific message, and `hydra messages` reads the queue. These actions never launch a worker; starting one is `task start` (below). Hydra’s own messages (actor `hydra`), including the lines Pnyx posts for its changes, appear in the chat as Hydra’s and stay readable through `hydra messages`, task history and `hydra check`, which lists them without waking on them. Several workers per task, automatic labels and quota reporting are later work.

## Starting workers and Hydra

`pnyx-axi task start <task> --via pnyx|paseo|firstmate|command` starts one worker for a task and attaches it; `pnyx-axi hydra start --via paseo|firstmate|command` starts the Hydra. Pnyx runs the agents it is asked to start; Hydra still decides what to do. Pnyx records each start on the Hydra.

- **Pnyx (the default):** `task start <task> [--kind <kind>] [--harness claude|codex] [--prompt "..."] [--folder <path>]` has the Hydra’s server (`pnyx-axi serve`) run Claude Code through the Agent SDK or Codex through `codex app-server` in the task's folder, with the brief as its first prompt. It records the native session or thread id, folder and settings on the task and loads your own provider configuration, skills and hooks. Install the chosen provider's CLI and sign in before starting. Hooks report to the same task. The chip reads **Claude Code · Pnyx** or **Codex · Pnyx**; the composer, `pnyx-axi reply` and model, effort and mode pickers (`pnyx-axi agent`) go straight to it, and working or finished comes from the agent itself. Codex applies picker changes on its next turn and queues messages sent during a turn. Stopping the server stops its agents: after a restart each task still shows its agent and conversation from the provider's own history, a running turn is marked interrupted and waits for you or Hydra, and the next message resumes the same session or thread. Tool permission requests appear inline with **Allow / Deny** and a **Needs you · permission** marker; the card stays in its column. Hydra sees them through `hydra check` and can answer with `pnyx-axi task permission <task> <request> allow|deny --actor hydra --reason "<why>"`; its reason appears in Hydra’s chat. Your own permission rules run first, so tools they already allow never ask in the Hydra. The first answer wins and does not change your permission rules. Command and file approvals apply once; Codex turn-permission requests show their turn scope and never grant session-wide access. Requests the agent no longer waits for expire, including after a server restart. Codex's mode selects its approval policy (`untrusted`, `on-request` or `never`); its sandbox follows your Codex configuration.
- **Paseo:** with [Paseo](https://paseo.sh) running, `--via paseo [--kind <kind>] [--harness claude|codex] [--prompt "..."] --folder <path>` asks the local daemon (`PNYX_PASEO_URL`, default `ws://127.0.0.1:6767/ws`) to start a Claude Code or Codex agent; the conversation and replies then go through Paseo, and the agent stays in Paseo too. Pnyx says so when Paseo is not running and never starts it. `task paseo` checks the daemon.
- **Firstmate:** on a Hydra run by a Firstmate home (the default route there), `--via firstmate [--prompt "..."]` puts a worker request in Hydra's chat and hands it to Firstmate as an inbox note. Firstmate dispatches the worker; its mirrored task can be nested under the Hydra task.
- **Your own command:** `pnyx-axi hydra set --hydra <id> --command '<shell command>'` sets a command, run in the task's folder with `PNYX_HOME`, `PNYX_HYDRA`, `PNYX_TASK`, `PNYX_ROLE` (`worker` or `hydra`), `PNYX_TASK_TITLE`, `PNYX_PROMPT`, `PNYX_HARNESS` and `PNYX_FOLDER` in its environment. The session it starts attaches to its task, or becomes Hydra, when its hooks first report.

Every agent Pnyx starts carries `PNYX_HOME` and `PNYX_HYDRA`, so its hooks report to the Hydra that started it, even from a separate Pnyx home, once `pnyx-axi setup hooks` has installed this version's hook. `pnyx-axi integrations` shows which of hooks, Paseo, Firstmate, the configured command and GitHub are ready, with the command that sets each up; the same list is under Settings > Integrations.

### Kinds, the light check and the worker contract

```sh
pnyx-axi kind set default --harness claude --model claude-opus-5-5 --effort high --mode acceptEdits
pnyx-axi kind set review --harness codex --effort high --quota high
pnyx-axi kind set hydra --harness claude --model claude-sonnet-5-5
pnyx-axi task start <task> --kind review
pnyx-axi hydra check --after <seq> --wait 1800
```

- **Kinds:** `kind set` records the agent each kind of task starts on: harness, model, effort and mode. Agents that Pnyx runs take their own model and effort; mode is Claude Code’s permission mode (such as `acceptEdits` or `bypassPermissions`) or Codex’s approval policy (`untrusted`, `on-request` or `never`); in Paseo, effort is Paseo's thinking option and mode is Paseo's mode. `--quota high|medium|low` picks, at start, the model with the most runway in that intelligence bucket for the harness through `quota-axi`, falling back to `--model` or Paseo's default. `task start` uses `--kind` or the `default` kind, and `hydra start` the `hydra` kind; without one, Claude Code with its default model. `--harness` on a start overrides the kind's; switching providers uses the chosen provider's model, effort and mode defaults and resolves quota for that provider, and without `--prompt` a worker opens with a message naming its task and the `pnyx-worker` skill. Set a flag to an empty value, or `--quota off`, to clear it. Settings → Agents on the Hydra edits the same kinds, and each change is its own event in the log; saving a kind never chooses the Hydra.
- **Direct conversations:** every owner message sent through a task card is already recorded with its send receipt. The light check also archives native transcript messages and completed Paseo replies into the same event log, including chats retained after detach and messages from an earlier task attachment. It returns a compact `conversations` digest grouped by task; Hydra treats the owner’s direct words as instructions and decides whether to act or take note. Excerpts point back to full task history, and the `through` cursor pages every event without dropping the rest. Echoes of Hydra sends and Hydra’s own answers are excluded from the digest. Unavailable native sources are reported for a later retry. Workers can escalate directly with `hydra send --task <task> --text "<question and context>"`.
- **Light check:** `hydra check` also returns an `agents` list with each attachment’s session, harness, launch route, folder, start time, last observation and current presence. A terminal observed before this boot or a process that exited is `gone`; a daemon or process that cannot be queried is `unknown`. These are observations for Hydra to inspect with `task history` and `task show --full`; Pnyx never relaunches agents. `hydra check` prints only what Hydra tracks (messages, task creation, brief and visibility changes, declarations, open agent questions, attachments, column changes, manual moves and links) after `--after`, with each event's id, task and message action, and skips Hydra's own writes (actor `hydra`, from `PNYX_ACTOR` or `--actor`). With `--wait` it blocks until one appears, so a background command or monitor wakes Hydra only when something changed, without loading the Hydra.
- **Workers:** a worker follows the `pnyx-worker` skill and reports with `task status <task> working|needs_you|paused|blocked|done --note <text>`; silence, idling and exit change nothing. To make the skills available to a Claude Code session outside a Firstmate home, link them from the clone: `ln -s "$PWD/skills/pnyx-hydra" "$PWD/skills/pnyx-worker" ~/.claude/skills/`.
- **Binding a session yourself:** `hydra set --session self` and `task attach <task> --session self` pick the session running in the caller's own Paseo terminal, tmux pane or Herdr pane.


## Using Pnyx

Create a task in any column with **+ Add task**, or add a column with **+ Add column**. Each click creates the real item and focuses its placeholder title. Creating a task clears active filters so the title stays visible. Rename a task in place, double-click a column title to rename it, and drag cards or column headers to move them; a card dropped on another goes above or below it by where it lands. Column deletion asks for inline confirmation and offers Undo.

- **Hydras:** the top bar has a tab per Hydra. Double-click the current Hydra's name to rename it; another tab opens that Hydra's own page, starting its server when none runs. **+ New Hydra** creates one and opens it with its name ready to type.
- **Columns:** Needs you, Workers on it, Done and Parked are the initial template. Use `pnyx-axi column create|rename|reorder|delete` to edit columns. Cards stay in the order you put them; agent state, declarations and merges never move or reorder one. Silence, finished turns and session exit never complete a task.
- **Continue in Pnyx:** after an outside Claude Code or Codex session ends, its open card offers **Continue in Pnyx**, or Hydra can run `pnyx-axi task continue <task>`. Pnyx checks that its recorded process has exited (or that it was last observed before this boot), records the same session as hosted, and resumes it in its recorded folder on the next message. A running session or uncertain presence refuses the handoff; `task continue <task> --check` reads the current eligibility without adopting it. The chip changes to **Claude Code · Pnyx** or **Codex · Pnyx**, and replies and settings go straight to the hosted agent. A missing folder offers **Start fresh from brief**, which opens the start form to choose a new folder and replaces the attachment only after the server validates the new start. `task start <task> --via pnyx --replace-session <session> --folder <path>` performs that fresh start from the CLI while preserving the old attachment if validation fails. Subagents cannot be continued in Pnyx.
- **Tasks and agents:** use a task’s Agent tab to attach or detach an existing interactive session. The task keeps its title, links and placement when a session moves. Use `task create --title "Work to do"`, `task sessions`, `task attach <task> --session <session>` and `task detach <task>`. Attaching or detaching never starts or stops a process. A task without an agent offers **Start agent**: Pnyx runs Claude Code or Codex itself by default, or it starts one through Paseo, its Firstmate home or the configured command.
- **Titles:** a card that only hooks report takes the harness's own session title, else its first prompt, else its folder name; a subagent takes its type and last 4 characters of its id (`Explore 3f2a`). A title you set is never replaced.
- **Agent questions:** when a session in a tmux pane waits on its own question, permission, plan or MCP form prompt, the task's conversation (or Hydra's chat, for Hydra's session) shows it with the options its terminal shows; answering types the keys that prompt expects. It shows as answered until the session's hooks report it moved on. Other terminals are answered in the session itself.
- **Hydra:** its chat stays docked on the left, with its composer at the bottom. Mod+Enter sends and Enter adds a line. Mod+B hides the top bar; the Hydra name in that bar switches Hydras.
- **Columns:** drag a header to reorder columns, or focus a header and use Mod+Left/Right. The ＋ creates a task at the top. The ⋯ menu renames, edits the hover description or deletes the column with an inline Yes/No confirmation. Drag the invisible right edge of a column or Hydra to resize it; Settings resets widths to their defaults.
- **Cards:** show their title and whether the attached agent is working or finished its turn. Settings can add the last message. Click a card or press Enter to expand its conversation downward at the same width. A task without a conversation opens to an editable brief; a worker started for it receives that brief as its opening prompt. Its ⋯ menu contains agent attachment and Add subtask. Summary and decision notes stay in the task record for Hydra.
- **Conversations:** replies use Markdown, user messages appear on the right, and tool calls and thinking use one-line rows. Select text with the mouse or keyboard caret, or press `c` on a block, to add independent comments, including nested passages. Comments travel with the next reply, identifying its original message time and including the paragraph for a selection of three words or fewer. The first comment in each conversation adds a short internal explanation marked “no reply needed.” Settings has separate Focus mode, Tool call details and Thinking details toggles: Focus hides traces; the details toggles decide whether visible rows expand.
- **Agent settings:** the composer takes its model, effort, mode and Fast controls from the integration. Changes use the agent's own route, or ask Firstmate for a task worker's change, and remain pending until reported. Direct Codex model and approval changes still use its native pickers; those unsupported controls stay disabled in Pnyx. `pnyx-axi agent <id>` provides the same integration controls.
- **Keyboard:** Mod is Command on macOS and Control elsewhere. Every binding can be changed in Settings, and the Character shortcuts switch there turns off the single-key ones.
  - Arrows or h/j/k/l: move between cards and columns; Home/End: first or last card
  - Enter: open the card's conversation at its reply input; `r`: focus the reply input; Mod+Enter: send (plain Enter adds a newline)
  - In the conversation: Escape from the reply input, Up at the very start of its draft, or Mod+L puts a text caret in the latest reply. Arrows, word and line jumps, Home/End and Page Up/Down move it like a text editor, skipping tool calls and thinking, and Shift extends a selection; with a selection Enter comments on it, typing starts a comment and Shift+Enter quotes it into the reply. `c` comments on the block at the caret, j/k jump between blocks, Down past the end or Mod+L returns to the reply input, Enter without a selection does too, and Escape hides the caret. Typing never changes the messages. The caret needs a Chromium browser.
  - Escape: dismiss suggestions, leave the reply input for the caret, hide the caret, then close the card
  - Mod+arrows: move the highlighted card or column; `/`: search history; Mod+F: focus Oracle
  - Mod+K: focus the top-bar Oracle; Mod+,: Settings; `?`: keyboard shortcuts in Settings
- **Oracle:** the top-bar Oracle field, History and `pnyx-axi oracle "<words>"` find cards by meaning, in any language, as well as by their words, across titles, links, events, notes and transcripts. Semantic search runs local models on your machine; the first search downloads them in the background (about 1 GB with a GPU, 115 MB on CPU only), and searches are full-text until they are ready. `pnyx-axi oracle status` shows the progress. The top-bar field filters tasks in place and lists matching task conversations and Hydra’s chat beneath it. Settings change directly in their result rows, and layout actions are available there too; start a query with `>` to show only settings and actions. Hidden sessions stay in History, reached through the “Search history” row. ⌘K (Ctrl+K elsewhere) focuses the same field, including from a reply composer and when the top bar is hidden.

Run `pnyx-axi --help` for every command.

## Skip semantic search

On a slow laptop, or to keep search full-text only:

- Leave out the optional packages it runs on (node-llama-cpp and sqlite-vec): after `pnpm run build`, run `pnpm install --no-optional` in the clone (before the build it would also drop the build tools' own native parts). Oracle then falls back to full-text silently.
- Or switch it off: Settings → Oracle, or `pnyx-axi settings set oracle.semantic off`. `PNYX_SEMANTIC=off` does the same for one shell or script. To free the disk, delete `~/.pnyx/models/`.

`pnyx-axi settings set oracle.rerank off` keeps meaning but skips the reranker, which costs about 0.4 s a search on a GPU (`auto`, the default, turns it off on CPU-only machines).

## Where data lives

Everything is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `settings.json`, the semantic search models in `models/` with the worker's `semantic.log`, and one folder per Hydra in `boards/<hydra>/` with `events.jsonl` (the append-only log), `snapshot.json`, `search.db` and `harvest.json`. Existing Hydras keep the `boards/` directories, `search.db` caches and event vocabulary, saved search settings and service identities on disk. Snapshots from an older version rebuild from the unchanged event log. The CLI uses `hydra`, `--hydra` and `oracle`; old command names and flags have no aliases. Rerun `pnyx-axi setup hooks` and `pnyx-axi setup service` after upgrading so installed hooks use `PNYX_HYDRA` and one login service runs every Hydra. Restart agents started before upgrading so their hooks inherit `PNYX_HYDRA`; their recorded tasks and conversations remain in the log. Nothing at runtime writes inside the repository.

To start a Hydra over, stop the server and delete its folder: `pnyx-axi stop && rm -rf ~/.pnyx/boards/default`. `pnyx-axi oracle rebuild` rebuilds only the search index.

## Uninstall

Remove the hooks first, since they point at the script in `~/.pnyx/hooks/`:

```sh
pnyx-axi stop
pnyx-axi setup hooks --remove
rm -rf ~/.pnyx
pnpm remove -g pnyx-axi
```

## Development

See [AGENTS.md](AGENTS.md) for the layout and design rules. `pnpm run lint` and `pnpm test` give deterministic verification. `pnpm test:web` runs a real browser smoke test through `chrome-devtools-axi` with a temporary `PNYX_HOME`, a random port, synthetic transcripts and a fake Firstmate send script; set `PNYX_EVIDENCE_DIR` to a folder outside the repository to keep its screenshots. `pnpm test:keyboard` exercises navigation, card and column moves, the top bar, comments and independent task/Hydra sends with real browser keys. `pnpm test:chat` covers Markdown rendering, nested comments, their delivery format and the reply input. `pnpm test:connection` covers offline sends, event resync, subscription recovery, reloads and heartbeat recovery. `pnpm test:semantic` checks semantic search on the real models; set `PNYX_GOLDEN_MODELS` to a folder already holding them to skip the download. `pnpm run web:dev` serves the Hydra through Vite.

```sh
pnpm dev
```

`pnpm dev` runs the Hydra server for a separate `dev` Hydra under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web app in place as you edit `web/`. Open the URL Vite prints; it forwards the Hydra's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).

Done cards are hidden from their Hydra after 24 continuous hours in Done. They are never deleted: their tasks, events and conversations stay in History and Oracle. Set the delay for each Hydra in Settings or with `pnyx-axi hydra set --hydra <id> --done-after-hours <hours>`; `0` keeps Done cards visible. Other columns never fade. Use the task menu in History to **Bring back to Hydra**, or run `pnyx-axi task unhide <id> --hydra <id>`; a restored card stays visible until it leaves Done and enters again. A reopened expired card returns automatically.

Cards show a compact project label beside their short title. Firstmate tasks use the item's project and omit a matching leading `<project>:` from the displayed title. Other tasks accept `pnyx-axi task create --title <title> --project <name>` or `pnyx-axi task rename <id> --project <name>`; an empty project value clears the label. Labels are searchable in the Hydra and Oracle.
