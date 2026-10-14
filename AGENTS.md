# Pnyx contributor guide

Pnyx is a deterministic board of every agent and its work, with an AXI CLI named `pnyx-axi`. Read `docs/design.md` before changing behavior.

## Build and test

Node 22.13 or newer (for the built-in `node:sqlite`) and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm run lint    # tsc --noEmit for the CLI and the web board, then ESLint
pnpm lint:fix    # ESLint --fix for spacing and line breaks; agents run it before committing
pnpm test        # builds the CLI and web board, then runs node --test
pnpm run web:dev # Vite dev server for the board
```

Tests use Node's built-in test runner and run TypeScript directly through Node's type stripping, so source must stay erasable TypeScript (no enums or namespaces). Tests never touch the real `~/.pnyx`, a real Firstmate home, Paseo, Herdr, tmux or any real terminal: use a temporary `PNYX_HOME`, a random port and `test/fixtures/`.

## Layout

One folder per feature. Code for a feature lives in its folder; a folder without code yet holds only a README saying what will live there. Do not add speculative code.

| Folder | Holds |
|---|---|
| `src/cli/` | the `pnyx-axi` entry and its commands |
| `src/core/` | event schema, board rules and the pure reducer |
| `src/store/` | `events.jsonl`, `snapshot.json`, the writer lock and the hook spool |
| `src/search/` | the full-text history search index (`search.db`), derived from the event log and recorded transcripts |
| `src/server/` | the local daemon and its WebSocket |
| `src/thread/` | the transcript and reply thread reader |
| `src/integrations/<name>/` | one source per folder (`hooks`, `firstmate`, `github`); each keeps both its reading side and its reply delivery |
| `web/` | the React + Vite + Tailwind board; its own UI primitives in `web/src/components/ui/` |
| `setup/` | hook templates per harness |
| `skills/pnyx/` | the agent skill shipped with the CLI |
| `test/` | tests; synthetic inputs in `test/fixtures/` |
| `docs/` | design and reference docs |

Repo skills for contributors live in `.agents/skills/`; `.claude/skills` links to it.

## Design rules

- Pnyx is a view plus a reply queue over existing tools. It does not orchestrate, dispatch or supervise agents.
- `pnyx-axi` is the only writer of board state. Every change is an event appended to the board's `events.jsonl`, which is append-only and never rewritten. `snapshot.json` is a cache rebuilt from the log and replaced atomically.
- The reducer is pure and deterministic: no I/O, clock or randomness inside it. Replaying the same log gives the same board.
- No database for board state, and no AI model calls or model tokens anywhere in the board's logic. `search.db` is a derived, deletable full-text index (SQLite FTS5 through `node:sqlite`), not a store: it is rebuilt from the log and transcripts and never read as board state. Opt-in semantic search adds vectors to it from local, open-weight models that run in `src/search`'s own worker process (`search setup` also loads them once, in its own process, for their golden check), never in the reducer, hooks or the server. The server's only token is a local per-install auth token for writes. Updates are pushed, and the browser uses one WebSocket.
- Hooks are silent (no stdout or stderr), fast, and always exit 0. They never wait on a network call, browser or model.
- The Firstmate integration only reads a Firstmate home's files and replies through Firstmate's own send command.
- GitHub pull request state comes from `gh-axi`.
- The CLI follows [AXI](https://axi.md/): compact TOON output, minimal default fields, explicit empty states, structured errors, no prompts and next-step hints.

## Runtime data

Boards live in `~/.pnyx/boards/<board>/` (`$PNYX_HOME/boards/<board>/` when `PNYX_HOME` is set): `events.jsonl`, `snapshot.json`, the lock, the spool, the `search.db` index and the `harvest.json` transcript cursors. Nothing at runtime writes inside the repository.
