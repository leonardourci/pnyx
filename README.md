# Pnyx

Pnyx tracks explicit tasks on boards, each with one orchestrator called Hydra. Create tasks and columns inline, attach an interactive agent session, and continue its conversation from the card. Ad-hoc agent sessions stay in History without creating tasks.

A deterministic board of every agent and its work, with an [AXI](https://axi.md/) CLI named `pnyx-axi`.

Pnyx records tasks, attaches one agent session to each task, and queues your replies to that session. It is a view over the tools you already use, not an orchestrator: Claude Code and Codex hooks report sessions, a Firstmate integration reads Firstmate's own records, and linked pull requests come from GitHub. Every change is an event in an append-only log, so the board can be replayed and audited. Pre-v1.

![Pnyx demo](docs/media/demo.gif)

The demo uses a synthetic fixture board. It shows `pnyx-axi setup hooks`, `pnyx-axi serve --home`, the four-column board, a card opened on its conversation, a card moved with `m`, a history search with `/`, and `pnyx-axi stop` plus `pnyx-axi setup hooks --remove`.

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
pnyx-axi serve                              # board only
pnyx-axi serve --home ~/path/to/firstmate   # also shows and replies to Firstmate tasks
```

Open the `url` it prints, http://127.0.0.1:4747 unless `--port` says otherwise; if that port is taken, `serve` exits with `PORT_IN_USE` rather than picking another. `pnyx-axi` with no arguments shows the board summary and the running server's address. Stop the server with Ctrl+C or `pnyx-axi stop`. When the server restarts on a new build at the same port, an open board reloads itself and keeps the open card, unsent drafts and scroll position.

To keep it running in the background:

```sh
mkdir -p ~/.pnyx
nohup pnyx-axi serve --home ~/path/to/firstmate > ~/.pnyx/serve.log 2>&1 &
pnyx-axi        # prints the URL
pnyx-axi stop
```

## Add your agents

```sh
pnyx-axi setup hooks                    # Claude Code and Codex, whichever config folder exists
pnyx-axi setup hooks --harness codex    # just one
pnyx-axi setup hooks --preview          # show what would change
pnyx-axi setup hooks --remove           # take Pnyx's hooks out again
```

This adds a silent reporting hook to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored), keeping every other hook. Hooks record sessions for explicit attachment. Ad-hoc sessions never create tasks; sessions without an interactive terminal stay in History. Each interactive session records the terminal it runs in so the board can type your replies into it: a tmux pane, a Herdr pane, a Paseo terminal, or an iTerm2 or Terminal window (macOS asks once to let Pnyx control that app; the answer lives under System Settings > Privacy & Security > Automation). A task without a reply route explains why beside its message input and keeps the draft. Already had the hooks installed? Re-run `pnyx-axi setup hooks` to enable typing into sessions. Codex asks you to review and trust new hooks once: run `/hooks` in Codex after installing. Rerun `pnyx-axi setup hooks` after upgrading Pnyx so the hooks cover the events the new version reads.

## Firstmate

Pass the board's Firstmate home to `serve` with `--home`; a board mirrors one Firstmate home, and `serve`, `firstmate sync` and `firstmate watch` name any other home they ignore. The server then watches the home's `state/` and `data/` folders, turns each task into a card, and sends your replies through the home's own `bin/fm-send.sh`. It only reads the home. Without a server, `pnyx-axi firstmate sync --home <path>` folds a home in once and `pnyx-axi firstmate watch --home <path>` keeps doing so; `pnyx-axi reply <id> --text <text> --home <path>` replies from the terminal. The first interactive Claude Code or Codex session in an open task's worktree joins that task; a later session in the same folder stays unassigned. The managed task keeps replying through Firstmate. A setting change from a task card's Agent tab goes to the orchestrator as a request note through the home's `bin/fm-inbox.sh note --request-id <id>`, with the same request id retained on retries. When Firstmate records a Paseo terminal, only sessions in that terminal can join or replace its worker; a replacement on the same terminal continues the task while earlier sessions remain in History.

## Task records

Hydra can be Firstmate or an ordinary agent session. Each board has one Hydra, and each explicit task has zero or one attached worker. Tasks support one level of subtasks. Pnyx records work and queues messages; Hydra decides what to do and dispatches workers. Changing Hydra preserves tasks, earlier worker attachments and messages to previous Hydras.

Use `board create|set|show|list` for boards, `column create|rename|delete|reorder|list` for their columns, and `task create|rename|status|list|show|history|chat` for work records. `task create --parent <task>` creates a subtask. Creating a task in a role column records that role's initial status; a custom column without a role pins placement. A manual move also pins placement. `column delete <id> --to <column>` moves every task in the deleted column to `--to` (the first remaining column by default) and pins it there, and Undo refuses to overwrite later edits. The final column cannot be deleted.

Tracking follows explicit declarations: working goes to Workers on it, needs_you and blocked to Needs you, paused to Parked, and done to Done. A confirmed PR merge also completes work. Silence, idle sessions and session exit do not complete tasks. Firstmate's backlog, status text and worker metadata are mirrored into retained task records, including backlog items without workers. A board stops mirroring a home when that home is no longer its Hydra.

The append-only log preserves board, task, subtask, session, command and message identities. Replaying existing events migrates old session records without changing their event bytes or ids. Unattached and headless sessions remain available in History and search. Harvested user and assistant messages are redacted and copied into the log on turn end, attachment changes and explicit `harvest`, so observed conversations remain readable and searchable after a native transcript disappears. Search remains a derived, deletable index.

`hydra send --text <message>` queues a board-level message with no task. `hydra send --task <task> [--action send|worker]` queues a task-specific message, and `hydra messages` reads the queue. Queuing never launches anything; Hydra acts on the queue (see Hydra and workers). Several workers per task, automatic labels, board tabs, inline questions and the left chat layout are later work.

## Hydra and workers

A board's Hydra can be any agent on any model. Firstmate runs a board with its own mechanics; any other agent follows the `pnyx-hydra` skill, and the workers it launches follow `pnyx-worker`. To make them available to Claude Code, link them from the clone: `ln -s "$PWD/skills/pnyx-hydra" "$PWD/skills/pnyx-worker" ~/.claude/skills/` (Codex reads `~/.codex/skills/`).

```sh
pnyx-axi kind set default --harness claude --model opus --effort high --mode acceptEdits
pnyx-axi kind set review --harness codex --effort high --quota high
pnyx-axi kind set hydra --harness claude --model sonnet
pnyx-axi hydra start --cwd ~/code/project        # launch Hydra in a Paseo terminal
pnyx-axi hydra check --after <seq> --wait 1800  # Hydra's light check
pnyx-axi worker create <task> --kind review --request <message id>
```

- **Kinds:** `kind set` records the agent each kind of task launches on: harness (Claude Code or Codex), model, effort and mode (Claude Code's permission mode, or Codex's `bypass` or a sandbox mode). `--quota high|medium|low` picks, at launch, the model with the most runway in that intelligence bucket for the harness through `quota-axi`, keeping `--model` when quota-axi cannot tell. `default` is used when `worker create` names no kind and `hydra` is what `hydra start` launches; both fall back to Claude Code's own defaults. Settings → Agents on the board edits the same kinds. Kinds are part of the board's configuration, so every change is in its log.
- **Launching:** `worker create <task>` opens a Paseo terminal in `--cwd` (else the task's folder, else the current one), types the kind's command line with a first prompt naming the task, and records `worker.launched` on the task with the agent, folder, terminal and the Hydra request it answers. The agent's first session in that terminal and folder joins the task, and the task's history keeps every worker that touched it. `--preview` prints the command line instead, for any other terminal. `hydra start` launches Hydra the same way; Hydra then binds itself with `board set --session self`, which picks the session running in the caller's own Paseo terminal, tmux pane or Herdr pane. Launched agents carry `PNYX_BOARD`, so their hooks report to that board, and `PNYX_ACTOR` (`hydra` or `worker:<task>`), which names them in the log.
- **Light check:** `hydra check` prints only what Hydra tracks (messages, task creation, declarations, attachments, column changes, manual moves, links and launches) after `--after`, skipping Hydra's own writes, without loading the board. With `--wait` it blocks until one appears, so a background command or monitor wakes Hydra only when something changed.
- **Declarations:** a worker reports with `task status <task> working|needs_you|paused|blocked|done --note <text>`; silence, idling and exit change nothing. Pnyx never supervises a launched process.

## Using the board

Create a task in any column with **+ Add task**, or add a column with **+ Add column**. Each click creates the real item and focuses its placeholder title. Creating a task clears active filters so the title stays visible. Rename a task in place, double-click a column title to rename it, and drag cards or column headers to move them. Column deletion asks for inline confirmation and offers Undo.

- **Columns:** Needs you, Workers on it, Done and Parked are the initial template. Use `pnyx-axi column create|rename|reorder|delete` to edit columns. Tasks move from declared status and confirmed merges; a manual card move pins placement. Silence, idle sessions and session exit never complete a task.
- **Tasks and agents:** use a task’s Agent tab to attach or detach an existing interactive session. The task keeps its title, links and placement when a session moves. Use `task create --title "Work to do"`, `task sessions`, `task attach <task> --session <session>` and `task detach <task>`. Attachments never start or stop a process.
- **Titles:** a card that only hooks report takes the harness's own session title, else its first prompt, else its folder name; a subagent takes its type and last 4 characters of its id (`Explore 3f2a`). A title you set is never replaced.
- **Hydra:** open the Hydra panel to send a board-level message. A task’s Send to Hydra or Create a worker button queues a task-specific request there; it never launches a process. Create a one-level subtask with **+ Subtask**.
- **Cards:** click a card or press Enter to expand its conversation inline by default, with notes, history and links; the reply input at the end of the conversation takes focus. Type a reply and press Mod+Enter to send it; type `/` there to insert a local Claude Code or Codex skill or command. Select text in a message, or press `c` on a selected block, to add an inline comment; comments go out with the next reply. Focus, on by default, shows only prompts and agent messages; turn it off to see tool calls and thinking.
- **Agent settings:** a card's Agent tab shows the session's model, effort, mode and fast mode, and changes them through the same route as a reply, with the harness's own commands and keys, or on a Firstmate task card as a request to its orchestrator (see Firstmate); `pnyx-axi agent <id>` does the same from the terminal. A change shows as pending until the session reports it. Claude Code saves a model, effort or fast mode set this way as your default for new sessions. A direct Codex session offers effort, fast mode and Plan mode here; Codex picks its model and approval mode only in its own `/model` and `/permissions` pickers.
- **Keyboard:** Mod is Command on macOS and Control elsewhere. Every binding can be changed in Settings, and the Character shortcuts switch there turns off the single-key ones.
  - Arrows or h/j/k/l: move between cards and columns; Home/End: first or last card
  - Enter: open the card's conversation at its reply input; `r`: focus the reply input; Mod+Enter: send (plain Enter adds a newline)
  - In the conversation: Escape moves into the transcript, arrows or j/k select message blocks, `c` comments on the selected block, Enter returns to the reply input
  - Escape: dismiss suggestions, leave the reply input, then close the card
  - `m`: move the focused card; `/`: search history; Mod+F: find a card in the current view
  - Mod+K: Commands; Mod+,: Settings; `?`: keyboard help; `f`: label visible controls, then type a label to jump to it
- **Search:** every search box (Find a card, History, the Cmd+K palette) and `pnyx-axi search "<words>"` find cards by meaning, in any language, as well as by their words, across titles, links, events, notes and transcripts. Semantic search runs local models on your machine; the first search downloads them in the background (about 1 GB with a GPU, 115 MB on CPU only), and searches are full-text until they are ready. `pnyx-axi search status` shows the progress.

Run `pnyx-axi --help` for every command.

## Skip semantic search

On a slow laptop, or to keep search full-text only:

- Leave out the optional packages it runs on (node-llama-cpp and sqlite-vec): after `pnpm run build`, run `pnpm install --no-optional` in the clone (before the build it would also drop the build tools' own native parts). Search then falls back to full-text silently.
- Or switch it off: Settings → Search on the board, or `pnyx-axi settings set search.semantic off`. `PNYX_SEMANTIC=off` does the same for one shell or script. To free the disk, delete `~/.pnyx/models/`.

`pnyx-axi settings set search.rerank off` keeps meaning but skips the reranker, which costs about 0.4 s a search on a GPU (`auto`, the default, turns it off on CPU-only machines).

## Where data lives

Everything is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `settings.json`, the semantic search models in `models/` with the worker's `semantic.log`, and one folder per board in `boards/<board>/` with `events.jsonl` (the append-only log), `snapshot.json`, `search.db` and `harvest.json`. Nothing at runtime writes inside the repository.

To start a board over, stop the server and delete its folder: `pnyx-axi stop && rm -rf ~/.pnyx/boards/default`. `pnyx-axi search rebuild` rebuilds only the search index.

## Uninstall

Remove the hooks first, since they point at the script in `~/.pnyx/hooks/`:

```sh
pnyx-axi stop
pnyx-axi setup hooks --remove
rm -rf ~/.pnyx
pnpm remove -g pnyx-axi
```

## Development

See [AGENTS.md](AGENTS.md) for the layout and design rules. `pnpm run lint` and `pnpm test` give deterministic verification. `pnpm test:web` runs a real browser smoke test through `chrome-devtools-axi` with a temporary `PNYX_HOME`, a random port, synthetic transcripts and a fake Firstmate send script; set `PNYX_EVIDENCE_DIR` to a folder outside the repository to keep its screenshots. `pnpm test:keyboard` exercises navigation, rebinding, hints and slash insertion with real browser keys. `pnpm test:chat` covers Markdown rendering, inline comments, Focus and the reply input. `pnpm test:semantic` checks semantic search on the real models; set `PNYX_GOLDEN_MODELS` to a folder already holding them to skip the download. `pnpm run web:dev` serves the board through Vite.

```sh
pnpm dev
```

`pnpm dev` runs the board server for a separate `dev` board under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web board in place as you edit `web/`. Open the URL Vite prints; it forwards the board's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).
