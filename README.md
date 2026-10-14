# Pnyx

A deterministic board of every agent and its work, with an [AXI](https://axi.md/) CLI named `pnyx-axi`.

Pnyx shows your coding agents as cards on one board and queues your replies to them. It is a view over the tools you already use, not an orchestrator: Claude Code and Codex hooks report sessions, a Firstmate integration reads Firstmate's own records, and linked pull requests come from GitHub. Every change is an event in an append-only log, so the board can be replayed and audited. Pre-v1; see [docs/design.md](docs/design.md) for the design.

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

This adds a silent reporting hook to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored), keeping every other hook. New sessions show up on the board, and each records the terminal it runs in so the board can type your replies into it: a tmux pane, a Herdr pane, a Paseo terminal, or an iTerm2 or Terminal window (macOS asks once to let Pnyx control that app; the answer lives under System Settings > Privacy & Security > Automation). A card without a route says why in its composer and keeps the draft. Already had the hooks installed? Re-run `pnyx-axi setup hooks` to enable typing into sessions. Codex asks you to review and trust new hooks once: run `/hooks` in Codex after installing. Rerun `pnyx-axi setup hooks` after upgrading Pnyx so the hooks cover the events the new version reads.

## Firstmate

Pass each Firstmate home to `serve` with `--home` (repeat it for several homes). The server then watches the home's `state/` and `data/` folders, turns each task into a card, and sends your replies through the home's own `bin/fm-send.sh`; a setting change from a task card's Agent tab goes to the orchestrator as a request note through the home's `bin/fm-inbox.sh`. It only reads the home. Without a server, `pnyx-axi firstmate sync --home <path>` folds a home in once and `pnyx-axi firstmate watch --home <path>` keeps doing so; `pnyx-axi reply <id> --text <text> --home <path>` replies from the terminal. A Claude Code or Codex session started in an open task's worktree joins that task's card, which keeps replying through Firstmate.

## Using the board

- **Columns:** Needs you (decisions, permission prompts, questions and idle sessions), Workers on it, Review (a linked pull request is open) and Done (every linked pull request merged, a recorded outcome, or an agent session that ended). A resumed session goes back to Workers on it; a Firstmate task is Done when Firstmate closes it. Cards move on their own from source facts; a manual move pins a card until you return it to automatic.
- **Titles:** a card that only hooks report takes the harness's own session title, else its first prompt, else its folder name; a subagent takes its type and last 4 characters of its id (`Explore 3f2a`). A title you set is never replaced.
- **Cards:** click a card or press Enter to open its conversation, notes, history and links. Type in the composer and press Mod+Enter to send a reply; type `/` there to insert a local Claude Code or Codex skill or command.
- **Agent settings:** a card's Agent tab shows the session's model, effort, mode and fast mode, and changes them through the same route as a reply, with the harness's own commands and keys (`pnyx-axi agent <id>` does the same from the terminal). A change shows as pending until the session reports it. Claude Code saves a model, effort or fast mode set this way as your default for new sessions.
- **Keyboard:** arrows or h/j/k/l move between cards, `m` moves the focused card, `/` searches history, Mod+K opens Commands, `?` shows help, `f` shows hints. Every binding can be changed in Settings. See [docs/keyboard.md](docs/keyboard.md).
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

See [AGENTS.md](AGENTS.md) for the layout and design rules. `pnpm run lint` and `pnpm test` give deterministic verification. `pnpm test:web` runs a real browser smoke test through `chrome-devtools-axi` with a temporary `PNYX_HOME`, a random port, synthetic transcripts and a fake Firstmate send script; set `PNYX_EVIDENCE_DIR` to a folder outside the repository to keep its screenshots. `pnpm test:keyboard` exercises navigation, rebinding, hints and slash insertion with real browser keys. `pnpm test:semantic` checks semantic search on the real models; set `PNYX_GOLDEN_MODELS` to a folder already holding them to skip the download. `pnpm run web:dev` serves the board through Vite.

```sh
pnpm dev
```

`pnpm dev` runs the board server for a separate `dev` board under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web board in place as you edit `web/`. Open the URL Vite prints; it forwards the board's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).
