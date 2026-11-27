# Othrys contributor guide

Othrys is a deterministic view of every agent and its work in Titans, with a small plain CLI named `othrys`.

Vocabulary: Othrys is the app, a **Titan** holds its tasks (always say Titan), search is the **Oracle**, and **inscribe** summarizes durable context before a reset and identifies memory changes to save. Everything else uses its plain name.

## Build and test

Node 22.13 or newer (for the built-in `node:sqlite`; `pnpm deslop` needs 22.18), pnpm (the version is pinned in `package.json`) and, for the browser tests, Google Chrome.

```sh
pnpm install
pnpm run lint    # tsc --noEmit for the CLI and the web Titan, then ESLint
pnpm lint:fix    # ESLint --fix for spacing and line breaks; agents run it before committing
pnpm test        # builds the CLI and web Titan, then runs the Vitest suite
pnpm run web:dev # Vite dev server for the Titan
```

For owner-facing trials in this repository, use an isolated `OTHRYS_HOME` and portless when installed: `OTHRYS_HOME=<dir> portless <name>.othrys othrys serve`. Choose a unique name, leave `--port` unset so Othrys uses portless's `PORT`, and give the owner the URL portless prints. Without portless, use `--port 0` and share the printed URL. Automated tests keep random ports. See [owner-facing trials](docs/development.md#owner-facing-trials).

Functions take one destructured object parameter; no-argument functions and signatures owned by external APIs keep their contracts.

Node runs the source directly through its type stripping, so source must stay erasable TypeScript (no enums or namespaces). Tests run on Vitest and never touch the real `~/.othrys`, Herdr, tmux or any real terminal: each test file gets a scratch home, native log files and random ports, and fixtures live in `tests/setup/fixtures/`. `docs/testing.md` describes the suite.

Every change to behaviour adds or updates tests for it; instruction-only and behaviour-preserving changes need none. Integration tests go in `tests/<area>.test.ts`, run through real `othrys` commands and the page's data calls against a scratch home, with tricky edge cases in the same file. Shared setup goes in `tests/setup/`. A test must survive a rename or refactor that keeps behaviour; write no duplicate, cosmetic or snapshot tests. A bug fix starts with a test that reproduces the bug, and the PR shows that each new test of new or changed behaviour fails without its change.

## Layout

One folder per feature. Code for a feature lives in its folder. Inside a feature, split a file when it holds unrelated concerns and keep closely related code together, as [follow-conventions](.agents/skills/follow-conventions/SKILL.md#files-and-concerns) describes. The root README introduces Othrys; usage and setup references live in `docs/`; tests and the test harness are described in `docs/testing.md`. Do not add speculative code.

| Folder | Holds |
|---|---|
| `src/cli/` | the `othrys` entry, its help and version |
| `src/app/` | the app shell that composes the features: native event logs, in-memory state and the writer, the closed event unions and the pure reducer, the CLI registry, and the server and host, with the resumed home socket |
| `src/store/` | storage primitives: private folders, durable writes, spool files, native log headers, snapshots, event ids and `TitanError` |
| `src/tasks/` | tasks, cards and columns, questions, holds and dependencies, reminders and retention; delivery (links, outcomes, landing and merges) in `src/tasks/delivery/` |
| `src/workers/` | dispatch, launch and sessions, the Claude and Codex providers, replies, steering, permissions, the queue and spend; compaction in `src/workers/compaction/` |
| `src/titan/` | Titan's identity and configuration, wakes, stalls and review, its session and commands, transcripts and the catalog, mentions and attachments |
| `src/memory/` | owner, project and Titan memory, its budgets and commands |
| `src/projects/` | attached projects, their identity and refresh, disposable copies and their Git helpers |
| `src/preferences/` | view and layout preferences and their commands |
| `src/settings/` | the settings every Titan shares: their append-only log, validation, `settings` command and the move from per-Titan values |
| `src/oracle/` | on-demand Oracle search over tasks, events and notes |
| `src/task-sources/` | task sources, called external sources in the CLI, events and docs: the process and review results that workers claim |
| `src/routine-helper/` | the routine helper: its state, leases, runner and commands |
| `src/setup/` | setup checks, the hook and skill installers, skill names and the login service |
| `src/upgrade/` | `/upgrade`: the queue, runner and restart |
| `src/integrations/<name>/` | one source per folder (`hooks`, `github`, `command`); each keeps both its reading side and its reply delivery. Their commands live in `src/integrations/cli.ts` |
| `web/` | the React + Vite + Tailwind Titan: its page shell in `web/src/app/`, shared UI primitives in `web/src/shared/ui/`, and one folder per feature beside them |
| `setup/` | hook templates per harness |
| `skills/` | the agent skills shipped with the CLI: `othrys-cli`, `othrys-report-progress`, and Titan's `othrys-orchestrate` contract with its detail skills (`othrys-manage-workers`, `othrys-arrange-columns`, `inscribe`, `othrys-set-up`) |
| `scripts/build/` | `pnpm run build`, which builds beside `dist` and replaces it only after the build passed |
| `scripts/fixtures/` | `pnpm refresh-agent-fixtures`, which records the agent sessions the fakes replay |
| `scripts/migrations/` | one-time home migrations, run by hand with the server stopped, such as `pnpm migrate-session-turns` |
| `tests/` | the test suite: one `<area>.test.ts` per area driving a real server through `othrys` and the page's data calls, a few checks of the real page in `browser/`, and the shared setup, fakes and fixtures in `setup/` |
| `docs/media/` | the README's screenshot |

Repo skills for contributors live in `.agents/skills/`; `.claude/skills` links to it. For pull requests, follow [write-pull-request](.agents/skills/write-pull-request/SKILL.md). Run `pnpm deslop` on committed work pushed to an open PR before readiness. It reviews and fixes the branch with the instructions in `deslop.config.json`, runs the quick local checks, waits for required CI and marks the commit; see [Development](docs/development.md#verification).

Every review, your own pre-PR pass included, has three parts that all block the merge: bugs, tests (each test fails when its behaviour breaks, nothing user-facing uncovered) and simpler (the clearest way to get the result: no copy of what exists, no dead code, one place for each rule, nothing the stack already provides, nothing that needs a comment to follow). A "looks off" item you can't prove still blocks: fix it or write in the PR why it stays. `write-front-end` also applies to changes under `web/`.

CodeRabbit is the on-request challenger before merge, replacing a separate agent challenger review, and reviews all three parts. Once a PR is green and ready for review, only the owner or Titan requests it; resolve or answer its comments. The configured review skills still apply. Follow the [CodeRabbit review flow](CONTRIBUTING.md#coderabbit-challenger-review); `pnpm deslop` neither requests nor requires CodeRabbit.

## Design rules

- Othrys is a view plus a reply queue over existing tools. Othrys runs the agents it is asked to start; Titan still decides what to do. `task start` runs Claude Code through the Agent SDK or Codex through its app-server inside the Othrys server, which stops them when it stops and resumes a turn it cut from the saved session when it starts again; a start can instead go through the Titan's own command, and Othrys never watches over those.
- The server (`othrys serve`) is the only writer of Titan state, and `othrys` is its client: every command except `serve`, `setup` and help runs in the server. Othrys keeps state in memory and saves decisions to `titan.log` and per-task `task.log` files through one ordered queue. Acknowledgements follow durable file writes. Snapshots cache folded state and byte positions; task folders determine Titan membership. Each turn start, resume and end of a session that belongs to a task or the Titan is saved in that task's `task.log`, or `titan.log` for the Titan, naming the session, harness, model and account that ran it and its transcript position; what Titan has read and which instructions a worker took are saved once observed too. Other observations stay in memory, and a restart reads each transcript only from its last saved turn record. Sessions that belong to no task and no Titan are followed only in memory: nothing about them is saved or read at a restart.
- The reducer is pure and deterministic: no I/O, clock or randomness inside it. Applying the same changes to the same starting state gives the same Titan. Restart loads a snapshot and each log tail, then reads each transcript from its last saved turn record.
- No AI model calls or model tokens anywhere in the Titan's logic. Oracle searches tasks, events and notes with a derived SQLite index, never agent transcripts. Queries catch up only unread events; no index work runs in the background. The server's only token is a local per-install auth token for writes. The browser reads Titan state, shared settings, agent activity, conversation pages and command receipts through one authenticated WebSocket. Reconnect resumes retained home changes by epoch and sequence, with a fresh snapshot when the cursor is unavailable.
- Hooks are fast and always exit 0, and they never wait on a network call, browser or model. They print nothing, except the session-start hook, which prints a short summary of the Titan's open work for the session's project.
- GitHub pull request state comes from `gh-axi`.
- The CLI handles immediate actions with plain text output and optional `--json`. Titan and workers read `titan.log`, `tasks/<task>/task.log`, `worker.log` and the optional snapshot directly; workers append their assigned `worker.log`.

## Runtime data

An Othrys home is `~/.othrys`, or `$OTHRYS_HOME` when set. Each `titans/<titan>/` holds `titan.log`, `snapshot.json`, `tasks/<task>/task.log`, the task's `worker.log` and derived `brief.md`, `oracle.db` (a derived search index), transcript cursors, spool files and `agent/`. Copies live under the home’s `copies/`; stable worker runtime files live under `runtime/tasks/<task>/`. Moving a task renames its folder while preserving its captured report path. New installations start in an empty home. Nothing at runtime writes inside the repository.
