# Pnyx

Pnyx brings your coding agents and their work into one local app.

It is for people working with Claude Code, Codex, or both across several projects. Talk to a **Hydra**, follow its tasks, and answer the questions that need you.

Every change is saved in an append-only event log, so work and conversations stay readable after a session ends.

Pnyx runs the agents you ask it to start; Hydra decides what to do.

The [AXI](https://axi.md/) CLI is `pnyx-axi`. Pnyx is pre-v1.

![Pnyx demo](docs/media/demo.gif)

Recorded on the current app in dark mode, with made-up projects, tasks and agents in an isolated data home.

## Install

You need Node 22.13 or newer and pnpm, at the version pinned in `package.json`.

Install and sign in to [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://developers.openai.com/codex/cli/), or both to run agents.

```sh
git clone https://github.com/leonardourci/pnyx.git
cd pnyx
pnpm install
pnpm run build
pnpm add -g "$PWD"
pnyx-axi --version
```

If pnpm's global bin directory is missing from PATH, run `pnpm setup`, reopen your terminal, and retry the global install. You can also run `./dist/cli/pnyx-axi.js` directly from the clone.

The global install links this clone; keep it in place. To upgrade, run `pnyx-axi upgrade` or send `/upgrade` in Hydra's chat; both pull `main`, install, build and restart the server.

GitHub integration needs [GitHub CLI](https://cli.github.com/), `gh auth login`, and [gh-axi](https://github.com/kunchenguid/gh-axi) on PATH.

[quota-axi](https://github.com/kunchenguid/quota-axi) ranks dispatch candidates by account quota. Hooks, global skills and the login service are optional setup steps described in the [reference](docs/pnyx-axi.md#install).

## Quick start

### 1. Run Pnyx

Start the foreground server:

```sh
pnyx-axi serve
```

Open the URL it prints. One server serves all your Hydras; the default address is `http://127.0.0.1:4747`.

Keep that terminal running while you use Pnyx.

For a trial with separate data and a free port:

```sh
PNYX_HOME=/path/to/trial pnyx-axi serve --port 0
```

Use the same `PNYX_HOME` for every command in that trial, including `stop`. A separate home still uses your normal harness logins and global skill folders.

Setup commands change user-wide configuration and require an explicit override for custom homes. See [data and privacy](docs/data.md) before sharing a data folder or removing it.

### 2. Attach a project

In another terminal, create a Hydra and attach a project:

```sh
pnyx-axi hydra create work
pnyx-axi project add /absolute/path/to/project --hydra work
```

Select **work** in the left panel, then choose a model for your signed-in harness in Hydra's composer (a Codex model if you use only Codex).

You can also type `/add-project` in Hydra's composer, or right-click the Hydra and choose **Add project**, to ask Hydra to attach a folder or clone a repository.

### 3. Talk to Hydra

Send a message in Hydra's composer, for example:

> Look at this project and help me plan a small improvement.

The first message starts Hydra's agent session. Hydra reports missing setup in chat and asks you to confirm owner-only changes.

Read the [dispatch guide](docs/pnyx-axi.md#kinds-the-light-check-and-the-worker-contract) to configure your harnesses, models and accounts.

### 4. Start a task

Ask Hydra to start an agreed task, or create and start one from the CLI:

```sh
pnyx-axi task create --title "Improve the empty state" --project project \
  --brief "Explain the empty state and add a useful next action." --hydra work
pnyx-axi task start <task-id> --harness claude --hydra work
```

Replace `project` with the attached folder's name and `<task-id>` with the ID returned by `task create`. Use `--harness codex` if that is your signed-in harness.

Open the card to follow the worker's updates, and send follow-up instructions through Hydra's chat. Stop a foreground server with Ctrl+C or `pnyx-axi stop`.

## Core ideas

### Hydra

A Hydra is an orchestrator and its tasks. It can work across several projects, keep context, dispatch workers, and bring decisions back to you.

The **Waiting on you** strip keeps open questions and permissions within reach.

### Tasks and columns

A task holds your ask, its brief, updates, conversation and links. Columns place cards from recorded facts such as working, paused, waiting on you or done.

You can create tasks and columns inline and move cards yourself. A finished agent turn leaves the task open until its completion requirements are met.

### Workers

Each task has at most one attached worker at a time. Pnyx can host Claude Code and Codex, or run your own command.

Workers report their state and send questions to Hydra. Hooks also let you attach existing interactive sessions.

### Projects and landing

A project is a folder attached to a Hydra. Workers normally get isolated project copies.

Work lands through a ready pull request by default, with you deciding when to merge; a project can instead keep completed work on a branch. See [projects and landing](docs/pnyx-axi.md#projects) for the rules and cleanup behavior.

### Memory and Oracle

Owner memory is shared across Hydras, project memory follows a project, and Hydra memory keeps that Hydra's local context. **inscribe** curates and saves those layers before a reset.

The **Oracle** searches tasks and recorded conversations by keyword, with stemming, synonyms and typo tolerance. Its index can be deleted and rebuilt from history.

## CLI reference

The main commands are below. `pnyx-axi --help` lists every command, and the [pnyx-axi reference](docs/pnyx-axi.md) covers them in full.

| Command | Description |
| --- | --- |
| `pnyx-axi` | Show the Hydra summary. |
| `pnyx-axi serve` | Run the one server for every Hydra until stopped. |
| `pnyx-axi stop` | Stop the running server. |
| `pnyx-axi upgrade [--check]` | Pull, install and build the latest `main`, then restart the server. |
| `pnyx-axi hydra create\|list\|show\|set` | Create and configure Hydras. |
| `pnyx-axi hydra start\|send\|messages\|check` | Start Hydra, queue a message in its chat, read the chat, or wait for changes. |
| `pnyx-axi project add\|list\|set\|remove` | Attach, list, configure or detach projects. |
| `pnyx-axi task create\|list\|show\|rename\|status\|history` | Manage tasks and one level of subtasks. |
| `pnyx-axi task start\|continue <task>` | Start a worker, or host an ended outside session. |
| `pnyx-axi task attach\|detach <task>` | Attach an interactive session to a task, or detach it. |
| `pnyx-axi column create\|rename\|describe\|rule\|resize\|reorder\|delete\|list` | Edit the Hydra's columns. |
| `pnyx-axi move <id> <column>` | Put a card in a column. |
| `pnyx-axi card <id>` | Show one card with its summary, decisions and context. |
| `pnyx-axi outcome <id> done\|failed\|cancelled` | Record a task's outcome. |
| `pnyx-axi oracle "<words>"` | Search titles, links, events and transcripts with the Oracle. |
| `pnyx-axi history` | Page through past events, newest first. |
| `pnyx-axi rule`, `pnyx-axi account list\|set\|remove` | Edit dispatch rules and worker login folders. |
| `pnyx-axi setup check\|skills\|hooks\|service` | List missing setup, or install global skills, reporting hooks or the login service. |
| `pnyx-axi integrations` | Show which integrations are ready and how to set each up. |
| `pnyx-axi undo <event-id>` | Append the reverse of a manual edit, move, link or outcome. |
| `pnyx-axi repair` | Set aside a torn log tail and rebuild the snapshot. |

### Flags

| Flag | Description |
| --- | --- |
| `--hydra <name>` | Hydra to use (default: `default`). |
| `--port <n>` | Port for `serve`; `0` picks a free one. |
| `--event-id <id>` | On writes, an idempotency key; a repeat returns the original receipt. |
| `--if-revision <n>` | On writes, the expected card revision (`0` for a new card). |
| `--help`, `--version` | Show command help or the installed version. |

## Documentation

- [pnyx-axi reference](docs/pnyx-axi.md): commands, projects, tasks, workers, memory and the interface.
- [Hooks and sessions](docs/hooks-and-sessions.md): attach existing agents and deliver replies.
- [Data, privacy and uninstall](docs/data.md): storage, retained history and removal.
- [Development](docs/development.md): build, tests and verification.
- [Contributing](CONTRIBUTING.md): propose a change and open a pull request.
- [Security](SECURITY.md): report a vulnerability privately.

## License

[Apache-2.0](LICENSE). Copyright 2026 Leonardo G. Urci.

Bundled third-party fonts, icons and artwork keep their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
