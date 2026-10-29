# Tests

- A `*.test.ts` beside the code it covers is a unit test, only for tricky pure logic: parsers, dispatch rules, the store rebuild and similar.
- `e2e/*.test.ts`: flows. Each one walks a user journey through the real `pnyx-axi` commands, the real server and the real saved files, with fake agents, checking along the way. There are no browser tests: check a page change in the local preview and the pull request's screenshots.
- `fixtures/` beside the code: synthetic inputs. `src/test-harness/recordings/` holds the recorded agent sessions the fakes replay.

Run the flows after a build (`scenarios` is the launcher's name for the `e2e/` lane):

```sh
pnpm build
node scripts/verification/test.ts scenarios
```

`pnpm test` and `pnpm verify` use the same isolated launcher. Each test file has its own temporary HOME, PNYX_HOME and harness directories, disabled external integrations and a guarded executable PATH. Actor, Hydra, task, port and model settings from the calling shell are discarded. Nothing else is inherited; PATH contains the guard scripts, the running Node installation and system tools. Checked pure files run four at a time and process and Git files two at a time, each file in its own process. The flows in `e2e/` run one at a time in a single process, so they share one server. The own-install flows run separately from a disposable installed checkout, using static imports of its built server and a throwaway Git origin. Each test fails by name after its lane's cap, and only one full run at a time holds the machine-wide lock.

For a small batch, pass explicit paths: `node scripts/verification/test.ts src/tasks/reminders.test.ts`.

`pnpm verify` picks what to run from the files the branch changes (see [Development](development.md)).

## Writing a flow

```ts
import { pnyx } from '#test-harness/pnyx.ts' // the one Pnyx every flow shares: temp PNYX_HOME, random port, fake agents

test('…', async () => {
  const s = await pnyx.scenario()       // a Hydra of its own, so flows never depend on each other
  const folder = s.folder({ name: 'app' })
  await s.owner({ args: ['task', 'create', '--title', 'Ship it', '--key', 'ship', '--folder', folder] })
  await s.owner({ args: ['task', 'start', 'ship'] })
  const worker = s.as({ agent: await s.agent({ cwd: folder }) })
  await worker.run({ args: ['task', 'status', 'ship', 'working'] })
  const page = await openPage({ port: pnyx.port(), hydraId: s.hydraId })
  await page.shows({ what: 'the card working', check: ({ state }) => … })
  await pnyx.restart()                  // the same files, a new server
})
```

- `s.owner` / `s.ownerRefused` run `pnyx-axi` as the owner; `s.as({ agent }).run` / `.refused` run it with the environment Pnyx gave that agent, so its identity is its own. A refusal returns the error `code`; `s.ownerRefusal` / `.refusal` return `{ code, error }`.
- `s.chat({ text })` is the owner writing in Hydra's chat, which starts Hydra; it returns Hydra's session once Hydra heard it. Hydra exists only after a chat message or a worker's report.
- `s.agent({ cwd })` is the worker session started in that folder, `s.agent({ hydra: true })` the Hydra's. `s.received({ cwd })` is every message the agents there got, across restarts, and `s.answered({ cwd })` how many of them had their turn end. A fake Claude session's `useTool({ tool, input })` asks for a tool's permission as Claude Code does mid-turn and resolves with Pnyx's decision.
- `s.project({ name, flags })` is a git project with its own bare origin, attached with `project add`; tasks in it start in their own copies. `s.pullRequest({ number, state, draft, checks, comments })` sets what the fake `gh-axi` reports for a pull request of the scenario's repository and returns its URL; the server reads followed pull requests every 100 ms. `s.merges({ number })` counts the merges `task merge` asked for.
- `openPage` is the owner's page over the WebSocket: `shows` waits until its state passes a check, `command` sends a command and returns its receipt.
- `s.state()`, `s.task({ key })` and `s.events()` read the Hydra's saved files.
- `s.owner({ args, input })` pipes `input` into the CLI, including `reply --file -`.
- `page.queues` records the server's worker-update queue messages, including waiting and reading batches.
- `pnyx.restart()` keeps the port, so an open page reconnects to the new server. Flows run one at a time, so a restart never cuts into another flow.

Rules:

- Wait with `until` (or `shows`) on something observable. No fixed sleeps, and no retries: a test that fails now and then is a bug. `until` stops on any value but `undefined` and `false`, so a count waits as `length > 0`.
- The server reads each write on its own schedule, and cuts the helper's next batch and Hydra's next wake from what it has read. Release a held turn that must see a write only once the server has read it, for example when an open page shows the write's seq.
- At most two heavy processes at once: the test process (which runs the server) and one awaited `pnyx-axi`. The Codex fake runs inside the test process.
- Nothing outside the scenario's temporary folder: never run `pnyx-axi setup`, never a real agent, terminal or GitHub.

## The fake agents

`src/test-harness/fake-agents.ts` replays real sessions: each message a fake Claude Code gets starts the recorded Agent SDK turn again, and the fake Codex app-server answers each request with its recorded result and notifications. Pnyx's own provider code reads that output, so a change in what the agents send shows up here.

After upgrading the Agent SDK (pinned to one exact version in `package.json`) or Codex, run `pnpm refresh-agent-fixtures`. It records one short real turn of each with your logins in a temporary folder, without your settings or hooks, and saves only what Pnyx reads.

For a controlled turn, `pnyx.claude.plan({ text, reply, hold })` matches the next prompt ending in `text` that an agent of the latest scenario's Hydra gets, and replays the recording with the chosen reply. A plan a flow leaves unused never answers another flow. A held turn streams its text and waits before the completed assistant message; call the returned `release()` in `finally`. `pnyx.codex.plan({ text, hold: true })` holds the recorded turn's output until released and accepts owner steering while it waits. These controls never start an outside agent.

The flows:
- `tasks.test.ts` covers a task's life, column rules and dependencies.
- `hydra.test.ts` covers Hydra messages and the queue.
- `questions.test.ts` covers permission requests and report choices.
- `steering.test.ts` covers steering a worker, the steering inbox and external sources.
- `landing.test.ts` covers landing a branch or a pull request and project refresh.
- `helper.test.ts` covers the routine helper's routing: progress that wakes nobody, batches while main works, capped batches and a failed batch's hand-back.
- `recovery.test.ts` covers restart and recovery, and a server that goes idle once nothing changes.
- `upgrade.test.ts` covers `/upgrade` against the flows' throwaway Pnyx folder (`pnyx.upgrade`): its place in Hydra's queue, a failed build, Stop, messages sent during it and the restart, which the flows count with `pnyx.restarts()` and finish with `pnyx.restart()`.
