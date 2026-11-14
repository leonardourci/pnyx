# Tests

The suite runs on [Vitest](https://vitest.dev). Most of it drives a real Pnyx server the way its users do: the owner and the agents through the built `pnyx-axi`, the page through its WebSocket and its Zero reads. A few journeys open the real page in Chrome.

```text
tests/
├── <area>.test.ts      one file per area: its integration tests and its tricky edge cases
├── e2e/
│   └── <journey>.test.ts   a few journeys through the real page in Chrome
└── setup/              the shared setup: Postgres, the server, fake agents, the browser, fixtures
```

## Running

Install PostgreSQL 15 or newer (`brew install postgresql@17`, or `sudo apt-get install postgresql`) and Google Chrome. Then:

```sh
pnpm test                                   # builds, then runs everything
pnpm exec vitest run tests/chat.test.ts     # one file, after a build
pnpm exec vitest run --project integration  # everything but the browser journeys
pnpm exec vitest run -t "Stop ends"         # tests whose name matches
```

The tests run the built CLI and serve the built page, so run `pnpm run build` after changing code under `src/` or `web/` before a focused run. `pnpm verify` and CI build first.

Set `PNYX_KEEP_TEST_FILES=<folder>` to copy each run's scratch homes and the Postgres log there before they are deleted; CI does this and uploads the folder when a run fails.

A run starts one throwaway PostgreSQL cluster on a random port, with logical replication for zero-cache, and migrates one template database through Pnyx's own connection code. Each test file then runs in its own process with a scratch `HOME` and `PNYX_HOME`, its own copy of the template database, a `PATH` whose `claude`, `codex`, `gh`, `gh-axi`, `paseo`, `firstmate`, `herdr`, `tmux`, `quota-axi`, `launchctl`, `systemctl` and `brew` fail loudly, and none of the calling shell's identity or settings. Files run in parallel and in a random order, and so do the tests in each file: the run prints its seed, and `--sequence.seed=<seed>` repeats that order. The tests in one file share its server, so each test sets up what it needs and must pass alone and in any order.

## Writing a test

Add to the area's file, or start a new `tests/<area>.test.ts` for a new area. A file starts its server once:

```ts
import { beforeAll, expect, test } from 'vitest'
import { startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

test('a reply reaches the worker once', async () => {
  const hydra = await pnyx.hydra()                       // a Hydra of its own
  const folder = hydra.folder({ name: 'app' })
  await hydra.owner({ args: ['task', 'create', '--title', 'Ship it', '--key', 'ship', '--folder', folder] })
  await hydra.owner({ args: ['task', 'start', 'ship'] })
  const worker = await hydra.agent({ cwd: folder })       // the fake agent Pnyx started there
  await hydra.owner({ args: ['reply', 'ship', '--text', 'Use Postgres'] })
  await until({ what: 'the reply', check: () => worker.received.some(text => text.includes('Use Postgres')) })
})
```

- `hydra.column({ role })` is a board column's id, `hydra.task({ key })` a task as `task show` prints it, and `hydra.startTask({ key, harness })` creates a task, starts its worker and waits for the worker's first turn.
- `hydra.owner({ args, input })` runs `pnyx-axi` as the owner and returns its output decoded from TOON; `hydra.ownerRefused` returns a refusal's `code` and `error`. `hydra.as({ session }).run` and `.refused` run it with the environment Pnyx gave that agent.
- `hydra.chat({ text })` is the owner writing in Hydra's chat; it resolves with Hydra's session once Hydra heard it. `hydra.agent({ cwd })` waits for the worker Pnyx started in a folder.
- `hydra.page()` opens the owner's page socket; `page.send({ name, args })` sends a command as the page does and resolves with its receipt or error.
- `rows({ text, values })` reads this file's database, for facts the page reads through Zero or a write must have saved.
- `pnyx.restart({ whileStopped })` stops the server and starts it again on the same home and port.
- `startPnyx({ zeroCache: true })` also runs zero-cache, for the page's Zero reads (`setup/zero.ts`) and the browser journeys (`setup/browser.ts`).

Rules:

- Assert what a user can observe: CLI output and refusals, the page's receipts and rows, what an agent received, saved events. Never source text, private helpers or snapshots.
- Check the refusal's `code`, and at most one fact of its text; never a whole English sentence.
- Wait with `until` on an observable condition. No fixed sleeps and no retries: a test that fails now and then is a bug.
- Use the IDs a command returned. Expected values are written out, not computed.
- Edge cases of tricky logic go in the same area file, calling the function directly only when the server cannot reach the case cheaply.
- A browser journey earns its place only for what needs a real page: rendering, scrolling, live updates.
- Nothing outside the test's scratch folders: never a real home, agent, terminal or GitHub.
- A test that pins a known bug is wrong; skip it with a note naming the task that fixes the bug. `tests/hooks.test.ts` holds one such skipped case.
- A hook, or any command a harness waits on, is judged by its outcome (it ended by itself, exit code, output), never by a wall-clock bound.

## The fakes

`setup/agents.ts` replays one real recorded turn of Claude Code (through the Agent SDK) and Codex (its app-server) from `setup/fixtures/agents/`, so Pnyx's provider code runs over what the agents really send. `pnyx.claude.plan({ hydra, text, reply, partial, hold })` shapes the next turn whose prompt ends with `text` (or the one `match` accepts): its reply, a streamed prefix and whether it waits for `release()`. `pnyx.codex.plan` also takes `refuse`, which makes the app-server answer that turn's start with an error, so Pnyx sees the agent refuse the message. A held Claude turn also ends when Pnyx stops it. A fake Claude session's `useTool({ tool, input })` asks for a tool's permission as Claude Code does mid-turn. After upgrading the Agent SDK or Codex, run `pnpm refresh-agent-fixtures` to record a fresh turn of each.

`setup/fixtures/gh-axi.mjs` stands in for `gh-axi`: set `PNYX_GH_AXI` to it and `PNYX_FAKE_GITHUB` to a folder holding `<owner>/<repo>/<number>.json` pull requests (`state`, `checks`, `head`, `draft` and `mergeBehavior`, `merged` or `queued`). It answers merge requests too and logs every call in `calls.jsonl`. The quota fake reports a login folder holding a file named `exhausted` as out of quota, and a missing folder as signed out. `setup/upgrade.ts` makes a throwaway Pnyx folder with its own origin, whose commits decide whether install, build or the data check fails.

## What each file covers

- `access.test.ts`: a worker's and Hydra's limits, Hydra's own permission requests, the page's token, socket, `/api/run` and image files, and that the page's Zero publication and rows never carry private steering.
- `chat.test.ts`: Hydra's chat, the queue, the routine helper's task lease, Stop, once-only delivery, resuming after a restart, and that Hydra's folder holds the shipped skills.
- `hooks.test.ts`: outside sessions reporting through the installed hook, with the server up or down.
- `oracle.test.ts`: search, its column, project and date filters and what it never reads.
- `paging.test.ts`: chat pages and a card's Activity pages.
- `projects.test.ts`: task copies, both landing rules and the merge gate.
- `settings.test.ts`: the settings every Hydra shares.
- `storage.test.ts`: atomic writes, the seq race, restart, the legacy `events.jsonl` import and the real `serve` entry.
- `migration.test.ts`: the migration from #378's schema at live size.
- `tasks.test.ts`: the board, dependencies, holds, undo and `apply`.
- `upgrade.test.ts`: `/upgrade`, its refusals, its rollback and its restart.
- `verification.test.ts`: which tests a change's paths call for, and the staged build.
- `worker-scope.test.ts`: a worker's `pnyx-axi` writes only to its own task, whichever way it was started, and keeps its reads and its own reporting; Hydra and the owner keep their rights.
- `workers.test.ts`: starting workers and choosing their account, replies and refused answers, permissions and resumed turns, on Claude and Codex.
- `e2e/board.test.ts`: the live board and a card's Activity in Chrome.
- `e2e/chat.test.ts`: sending, streaming, Stop, reload, scrolling back through a long chat and resting at its bottom in Chrome.
