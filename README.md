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

Open the `url` it prints. `pnyx-axi` with no arguments shows the board summary and the running server's address. Stop the server with Ctrl+C or `pnyx-axi stop`.

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

This adds a silent reporting hook to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored), keeping every other hook. New sessions show up on the board. Codex asks you to review and trust new hooks once: run `/hooks` in Codex after installing.

## Firstmate

Pass each Firstmate home to `serve` with `--home` (repeat it for several homes). The server then watches the home's `state/` and `data/` folders, turns each task into a card, and sends your replies through the home's own `bin/fm-send.sh`. It only reads the home. Without a server, `pnyx-axi firstmate sync --home <path>` folds a home in once and `pnyx-axi firstmate watch --home <path>` keeps doing so; `pnyx-axi reply <id> --text <text> --home <path>` replies from the terminal.

## Using the board

- **Columns:** Needs you (decisions and interruptions), Workers on it, Review (a linked pull request is open) and Done. Cards move on their own from source facts; a manual move pins a card until you return it to automatic.
- **Cards:** click a card or press Enter to open its conversation, notes, history and links. Type in the composer and press Mod+Enter to send a reply; type `/` there to insert a local Claude Code or Codex skill or command.
- **Keyboard:** arrows or h/j/k/l move between cards, `m` moves the focused card, `/` searches history, Mod+K opens Commands, `?` shows help, `f` shows hints. Every binding can be changed in Settings. See [docs/keyboard.md](docs/keyboard.md).
- **Search:** the History page searches titles, links, events, notes and transcripts. From the terminal, `pnyx-axi search "<words>"`. To also find work by meaning, in any language, run `pnyx-axi search setup --semantic` once: it installs the node-llama-cpp runtime with npm, downloads local models (about 1 GB with a GPU, 115 MB on CPU only) and turns semantic search on. Turn it off on a slow machine with `pnyx-axi settings set search.semantic off` or the switch in Settings.

Run `pnyx-axi --help` for every command.

## Where data lives

Everything is in `~/.pnyx/` (or `$PNYX_HOME`): the hook script in `hooks/`, the local write token, `settings.json`, the semantic search runtime in `runtime/` and models in `models/` with the worker's `semantic.log`, and one folder per board in `boards/<board>/` with `events.jsonl` (the append-only log), `snapshot.json`, `search.db` and `harvest.json`. Nothing at runtime writes inside the repository.

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
