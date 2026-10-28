# Pnyx contributor guide

Pnyx is a deterministic view of every agent and its work in Hydras, with an AXI CLI named `pnyx-axi`.

Vocabulary: Pnyx is the app, a **Hydra** holds its tasks (always say Hydra, never board), search is the **Oracle**, and **inscribe** is how Hydra curates and saves its memory before a reset. Everything else uses its plain name.

## Build and test

Node 22.13 or newer (for the built-in `node:sqlite`) and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm run lint    # tsc --noEmit for the CLI and the web Hydra, then ESLint
pnpm lint:fix    # ESLint --fix for spacing and line breaks; agents run it before committing
pnpm test        # builds the CLI and web Hydra, then runs node --test
pnpm run web:dev # Vite dev server for the Hydra
```

Functions take one destructured object parameter; no-argument functions and signatures owned by external APIs keep their contracts.

Tests use Node's built-in test runner and run TypeScript directly through Node's type stripping, so source must stay erasable TypeScript (no enums or namespaces). Tests never touch the real `~/.pnyx`, a real Firstmate home, Paseo, Herdr, tmux or any real terminal: use a temporary `PNYX_HOME`, a random port and fixtures from `test/fixtures/` or a `fixtures/` folder beside the code.

## Layout

One folder per feature. Code for a feature lives in its folder. The root README introduces Pnyx; usage and setup references live in `docs/`; the only per-folder README is `test/README.md`, for the test harness. Do not add speculative code.

| Folder | Holds |
|---|---|
| `src/cli/` | the `pnyx-axi` entry and the commands that have not moved into `src/app/` or a feature folder yet |
| `src/app/` | the app shell that composes the features: event log, snapshots and the writer, the closed event unions and the pure reducer, the CLI registry, and the server and host |
| `src/core/` | feature event types and Hydra rules not yet in their feature folder |
| `src/store/` | storage primitives: private folders, durable writes, the writer lock, spool files, the event envelope, event ids and `HydraError`, plus retention until its feature moves |
| `src/oracle/` | the full-text history search index (`search.db`), derived from the event log and recorded transcripts |
| `src/server/` | the agents the server runs and the login service |
| `src/thread/` | the transcript and reply thread reader |
| `src/integrations/<name>/` | one source per folder (`hooks`, `firstmate`, `github`, `paseo`, `command`); each keeps both its reading side and its reply delivery |
| `src/preferences/` | keyboard rules, view and layout preferences and their commands |
| `src/memory/` | owner, project and Hydra memory, its budgets and commands |
| `src/projects/` | attached projects, their identity and refresh, disposable copies and their Git helpers |
| `web/` | the React + Vite + Tailwind Hydra: its page shell in `web/src/app/`, shared UI primitives in `web/src/shared/ui/` and feature-bound ones still in `web/src/components/ui/` |
| `setup/` | hook templates per harness |
| `skills/` | the agent skills shipped with the CLI: `pnyx-cli`, `pnyx-report-progress`, and Hydra's `pnyx-orchestrate` contract with its detail skills (`pnyx-manage-workers`, `pnyx-arrange-columns`, `pnyx-firstmate-as-hydra`, `pnyx-inscribe`, `pnyx-set-up`) |
| `src/test-harness/` | the shared test harness: the flow runner, fake agents and their recorded sessions, and fake tools |
| `scripts/verification/` | the isolated test launcher and `pnpm verify` |
| `scripts/fixtures/` | `pnpm refresh-agent-fixtures`, which records the agent sessions the fakes replay |
| `test/` | tests not yet beside their code; synthetic inputs in `test/fixtures/` |
| `docs/media/` | the README's demo GIF |

Repo skills for contributors live in `.agents/skills/`; `.claude/skills` links to it. Before PR readiness, run `pnpm verify` to select the required checks and reviews for the changed files. Follow the required checklists in order: `review-code`, `audit-tests`, then `deslop`. These are checklists for humans and agents alike. Tick only the required PR checkboxes after completing them, and describe what you fixed in the PR description. `write-front-end` also applies to changes under `web/`.

## Design rules

- Pnyx is a view plus a reply queue over existing tools. Pnyx runs the agents it is asked to start; Hydra still decides what to do. `task start` runs Claude Code through the Agent SDK or Codex through its app-server in the Hydra's server; a start can instead go through the local Paseo daemon, a Firstmate home or the Hydra's own command, and Pnyx never watches over those.
- `pnyx-axi` is the only writer of Hydra state. Every change is an event appended to the Hydra's `events.jsonl`, which is append-only and never rewritten. `snapshot.json` is a cache rebuilt from the log and replaced atomically.
- The reducer is pure and deterministic: no I/O, clock or randomness inside it. Replaying the same log gives the same Hydra.
- No database for Hydra state, and no AI model calls or model tokens anywhere in the Hydra's logic. `search.db` is a derived, deletable full-text index (SQLite FTS5 through `node:sqlite`), not a store: it is rebuilt from the log and transcripts and never read as Hydra state. The server's only token is a local per-install auth token for writes. Updates are pushed, and the browser uses one WebSocket.
- Hooks are fast and always exit 0, and they never wait on a network call, browser or model. They print nothing, except the session-start hook, which prints a short summary of the Hydra's open work for the session's project.
- The Firstmate integration only reads a Firstmate home's files and replies through Firstmate's own send and inbox commands. The one write is `setup hydra`, which adds the Hydra skills as local, git-excluded skills in the home; Firstmate's tracked files never change.
- GitHub pull request state comes from `gh-axi`.
- The CLI follows [AXI](https://axi.md/): compact TOON output, minimal default fields, explicit empty states, structured errors, no prompts and next-step hints.

## Runtime data

Hydras live in `~/.pnyx/hydras/<hydra>/` (`$PNYX_HOME/hydras/<hydra>/` when `PNYX_HOME` is set): `events.jsonl`, `snapshot.json`, the lock, the spool, the `search.db` index, the `harvest.json` transcript cursors, and `agent/`, the hosted Hydra's folder, whose contract and skills Pnyx rewrites before each Hydra turn. Nothing at runtime writes inside the repository.
