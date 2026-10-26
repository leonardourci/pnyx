# Pnyx contributor guide

Pnyx is a deterministic view of every agent and its work in Hydras, with an AXI CLI named `pnyx-axi`.

Vocabulary: Pnyx is the app, a **Hydra** holds its tasks (always say Hydra, never board), search is the **Oracle**, and **inscribe** is how Hydra curates and saves its memory before a reset. Everything else uses its plain name.

## Build and test

Node 22.13 or newer (for the built-in `node:sqlite`), pnpm (the version is pinned in `package.json`), and Chrome for the browser journeys (or `PNYX_CHROME` set to its binary).

```sh
pnpm install
pnpm run lint    # tsc --noEmit for the CLI and the web Hydra, then ESLint
pnpm lint:fix    # ESLint --fix for spacing and line breaks; agents run it before committing
pnpm test        # builds the CLI and web Hydra, then runs node --test
pnpm run web:dev # Vite dev server for the Hydra
```

Functions take one destructured object parameter; no-argument functions and signatures owned by external APIs keep their contracts.

Tests use Node's built-in test runner and run TypeScript directly through Node's type stripping, so source must stay erasable TypeScript (no enums or namespaces). Tests never touch the real `~/.pnyx`, a real Firstmate home, Paseo, Herdr, tmux or any real terminal: use a temporary `PNYX_HOME`, a random port and `test/fixtures/`.

## Layout

One folder per feature. Code for a feature lives in its folder. Usage and setup live in the root README; the only per-folder README is `test/README.md`, for the test harness. Do not add speculative code.

| Folder | Holds |
|---|---|
| `src/cli/` | the `pnyx-axi` entry and its commands |
| `src/core/` | event schema, Hydra rules and the pure reducer |
| `src/store/` | `events.jsonl`, `snapshot.json`, the writer lock and the hook spool |
| `src/oracle/` | the full-text history search index (`search.db`), derived from the event log and recorded transcripts |
| `src/server/` | the local daemon, its WebSocket and the agents it runs |
| `src/thread/` | the transcript and reply thread reader |
| `src/integrations/<name>/` | one source per folder (`hooks`, `firstmate`, `github`, `paseo`, `command`); each keeps both its reading side and its reply delivery |
| `web/` | the React + Vite + Tailwind Hydra; its own UI primitives in `web/src/components/ui/` |
| `setup/` | hook templates per harness |
| `skills/` | the agent skills shipped with the CLI: `pnyx`, `pnyx-worker`, and Hydra's `pnyx-hydra` contract with its detail skills (`pnyx-hydra-workers`, `pnyx-hydra-columns`, `pnyx-hydra-firstmate`, `inscribe`, `pnyx-setup`) |
| `test/` | tests; synthetic inputs in `test/fixtures/` |
| `docs/media/` | the README's demo GIF |

Repo skills for contributors live in `.agents/skills/`; `.claude/skills` links to it. Before PR readiness, run `pnpm verify` to select the required checks and reviews for the changed files. Follow the required checklists in order: `review-code`, `audit-tests`, then `deslop`. These are checklists for humans and agents alike. Tick only the required PR checkboxes after completing them, and describe what you fixed in the PR description. `write-front-end` also applies to changes under `web/`.

## Design rules

- Pnyx is a view plus a reply queue over existing tools. Pnyx runs the agents it is asked to start; Hydra still decides what to do. `task start` runs Claude Code through the Agent SDK or Codex through its app-server in the Hydra's server; a start can instead go through the local Paseo daemon, a Firstmate home or the Hydra's own command, and Pnyx never watches over those.
- `pnyx-axi` is the only writer of Hydra state. Every change is an event appended to the Hydra's `events.jsonl`, which is append-only and never rewritten. `snapshot.json` is a cache rebuilt from the log and replaced atomically.
- The reducer is pure and deterministic: no I/O, clock or randomness inside it. Replaying the same log gives the same Hydra.
- No database for Hydra state, and no AI model calls or model tokens anywhere in the Hydra's logic. `search.db` is a derived, deletable full-text index (SQLite FTS5 through `node:sqlite`), not a store: it is rebuilt from the log and transcripts and never read as Hydra state. Semantic search (on by default, through optional dependencies) adds vectors to it from local, open-weight models that run in `src/oracle`'s own worker process (`oracle setup` also loads them once, in its own process, for their golden check), never in the reducer, hooks or the server. The server's only token is a local per-install auth token for writes. Updates are pushed, and the browser uses one WebSocket.
- Hooks are silent (no stdout or stderr), fast, and always exit 0. They never wait on a network call, browser or model.
- The Firstmate integration only reads a Firstmate home's files and replies through Firstmate's own send and inbox commands. The one write is `setup hydra`, which adds the Hydra skills as local, git-excluded skills in the home; Firstmate's tracked files never change.
- GitHub pull request state comes from `gh-axi`.
- The CLI follows [AXI](https://axi.md/): compact TOON output, minimal default fields, explicit empty states, structured errors, no prompts and next-step hints.

## Runtime data

Hydras live in `~/.pnyx/hydras/<hydra>/` (`$PNYX_HOME/hydras/<hydra>/` when `PNYX_HOME` is set): `events.jsonl`, `snapshot.json`, the lock, the spool, the `search.db` index, the `harvest.json` transcript cursors, and `agent/`, the hosted Hydra's folder, whose contract and skills Pnyx rewrites before each Hydra turn. Nothing at runtime writes inside the repository.
