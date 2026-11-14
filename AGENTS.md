# Pnyx contributor guide

Pnyx is a deterministic view of every agent and its work in Hydras, with an AXI CLI named `pnyx-axi`.

Vocabulary: Pnyx is the app, a **Hydra** holds its tasks (always say Hydra, never board), search is the **Oracle**, and **inscribe** is how Hydra curates and saves its memory before a reset. Everything else uses its plain name.

## Build and test

Node 22.13 or newer (for the built-in `node:sqlite`), pnpm (the version is pinned in `package.json`) and, for the tests, PostgreSQL 15 or newer (`brew install postgresql@17`).

```sh
pnpm install
pnpm run lint    # tsc --noEmit for the CLI and the web Hydra, then ESLint
pnpm lint:fix    # ESLint --fix for spacing and line breaks; agents run it before committing
pnpm test        # builds the CLI and web Hydra, then runs the Vitest suite
pnpm run web:dev # Vite dev server for the Hydra
```

Functions take one destructured object parameter; no-argument functions and signatures owned by external APIs keep their contracts.

Node runs the source directly through its type stripping, so source must stay erasable TypeScript (no enums or namespaces). Tests run on Vitest and never touch the real `~/.pnyx`, a real Firstmate home, Paseo, Herdr, tmux or any real terminal: each test file gets a scratch home, its own copy of a migrated database and random ports, and fixtures live in `tests/setup/fixtures/`. `docs/testing.md` describes the suite.

## Layout

One folder per feature. Code for a feature lives in its folder. Inside a feature, split a file when it holds unrelated concerns and keep closely related code together, as [follow-conventions](.agents/skills/follow-conventions/SKILL.md#files-and-concerns) describes. The root README introduces Pnyx; usage and setup references live in `docs/`; tests and the test harness are described in `docs/testing.md`. Do not add speculative code.

| Folder | Holds |
|---|---|
| `src/cli/` | the `pnyx-axi` entry, its help and version |
| `src/app/` | the app shell that composes the features: event log, Postgres rows and the writer, the closed event unions and the pure reducer, the CLI registry, and the server and host, with its zero-cache child and `/zero` proxy |
| `src/store/` | storage primitives: private folders, durable writes, lock files, the Postgres connection, spool files, the event envelope, event ids and `HydraError`; the Postgres tables (`schema.sql`) and the page's Zero schema and queries |
| `src/tasks/` | tasks, cards and columns, questions, holds and dependencies, reminders and retention; delivery (links, outcomes, landing and merges) in `src/tasks/delivery/` |
| `src/workers/` | dispatch, launch and sessions, the Claude and Codex providers, replies, steering, permissions, the queue and spend; compaction in `src/workers/compaction/` |
| `src/hydra/` | Hydra's identity and configuration, wakes, stalls and review, its session and commands, transcripts and the catalog, mentions and attachments |
| `src/memory/` | owner, project and Hydra memory, its budgets and commands |
| `src/projects/` | attached projects, their identity and refresh, disposable copies and their Git helpers |
| `src/preferences/` | keyboard rules, view and layout preferences and their commands |
| `src/settings/` | the settings every Hydra shares: their append-only log, validation, `settings` command and the move from per-Hydra values |
| `src/oracle/` | on-demand Oracle search over tasks, events and notes |
| `src/investigations/` | investigation reports and their review inventory |
| `src/task-sources/` | task sources, called external sources in the CLI, events and docs: the process and review results that workers claim |
| `src/routine-helper/` | the routine helper: its state, leases, runner and commands |
| `src/setup/` | setup checks, the hook and skill installers, skill names and the login service |
| `src/upgrade/` | `/upgrade` and `pnyx-axi upgrade`: the queue, runner and restart |
| `src/integrations/<name>/` | one source per folder (`hooks`, `firstmate`, `github`, `paseo`, `command`); each keeps both its reading side and its reply delivery. Their commands live in `src/integrations/cli.ts` |
| `web/` | the React + Vite + Tailwind Hydra: its page shell in `web/src/app/`, shared UI primitives in `web/src/shared/ui/`, and one folder per feature beside them |
| `setup/` | hook templates per harness |
| `skills/` | the agent skills shipped with the CLI: `pnyx-cli`, `pnyx-report-progress`, and Hydra's `pnyx-orchestrate` contract with its detail skills (`pnyx-manage-workers`, `pnyx-arrange-columns`, `pnyx-firstmate-as-hydra`, `inscribe`, `pnyx-set-up`) |
| `scripts/build/` | `pnpm run build`, which builds beside `dist` and replaces it only after the build passed |
| `scripts/verification/` | `pnpm verify`, its marker and the machine-wide run lock |
| `scripts/fixtures/` | `pnpm refresh-agent-fixtures`, which records the agent sessions the fakes replay |
| `tests/` | the test suite: one `<area>.test.ts` per area driving a real server through `pnyx-axi` and the page's data calls, a few browser journeys in `e2e/`, and the shared setup, fakes and fixtures in `setup/` |
| `docs/media/` | the README's demo GIF |

Repo skills for contributors live in `.agents/skills/`; `.claude/skills` links to it. For pull requests, follow [write-pull-request](.agents/skills/write-pull-request/SKILL.md). Before PR readiness, run `pnpm verify` to select the required checks and reviews for the changed files. Follow the required checklists in order: `review-code`, `audit-tests`, then `deslop`. These are checklists for humans and agents alike. Tick only the required PR checkboxes after completing them, and describe what you fixed in the PR description. `write-front-end` also applies to changes under `web/`.

CodeRabbit is the on-request challenger before merge, replacing a separate agent challenger review. Once a PR is green and ready for review, only the owner or Hydra requests it; resolve or answer its comments. The local review checklists above still apply. Follow the [CodeRabbit review flow](CONTRIBUTING.md#coderabbit-challenger-review); `pnpm verify` neither requests nor requires CodeRabbit.

## Design rules

- Pnyx is a view plus a reply queue over existing tools. Pnyx runs the agents it is asked to start; Hydra still decides what to do. `task start` runs Claude Code through the Agent SDK or Codex through its app-server inside the Pnyx server, which stops them when it stops and resumes a turn it cut from the saved session when it starts again; a start can instead go through the local Paseo daemon, a Firstmate home or the Hydra's own command, and Pnyx never watches over those.
- The server (`pnyx-axi serve`) is the only writer of Hydra state, and `pnyx-axi` is its client: every command except `serve`, `stop`, `restart`, `setup`, `upgrade` and help runs in the server. Pnyx's own data lives in Postgres (`src/store/schema.sql`), one database per Pnyx home. Every change is an event appended to the `events` table, which is append-only. The server keeps each Hydra in memory; each command commits its events and the rows they changed in one transaction, which moves the Hydra's `seq` only from the value the command started at.
- The reducer is pure and deterministic: no I/O, clock or randomness inside it. Replaying the same log gives the same Hydra.
- No AI model calls or model tokens anywhere in the Hydra's logic. Oracle searches tasks, events and notes with a derived SQLite index, never agent transcripts. Queries catch up only unread events; no index work runs in the background. The server's only token is a local per-install auth token for writes; a Hydra's page also gets it as an HttpOnly cookie for `/zero`. Updates are pushed: the browser gets live agent activity, conversation pages and command receipts over one WebSocket to the server, and Hydra data over Zero's socket at `/zero`. `serve` also runs zero-cache as its child for the page's reads, proxied at `/zero` on the server's own port, with no mutators; zero-cache builds each read from the named queries in `src/store/zero-schema.ts` through the server's `/zero-query` endpoint.
- Hooks are fast and always exit 0, and they never wait on a network call, browser or model. They print nothing, except the session-start hook, which prints a short summary of the Hydra's open work for the session's project.
- The Firstmate integration only reads a Firstmate home's files and replies through Firstmate's own send and inbox commands. The one write is `setup hydra`, which adds the Hydra skills as local, git-excluded skills in the home; Firstmate's tracked files never change.
- GitHub pull request state comes from `gh-axi`.
- The CLI follows [AXI](https://axi.md/): compact TOON output, minimal default fields, explicit empty states, structured errors, no prompts and next-step hints.

## Runtime data

A Pnyx home's data is in its Postgres database: `pnyx` for `~/.pnyx`, and a name derived from the path for any other `PNYX_HOME`. Each Hydra's folder, `~/.pnyx/hydras/<hydra>/` (`$PNYX_HOME/hydras/<hydra>/` when `PNYX_HOME` is set), holds the spool, `oracle.db` (the derived Oracle cache), the `harvest.json` transcript cursors, and `agent/`, the hosted Hydra's folder, whose contract and skills Pnyx rewrites before each Hydra turn. An `events.jsonl` from before Postgres is imported in one transaction when the server first serves its Hydra and stays as a backup. Nothing at runtime writes inside the repository.
