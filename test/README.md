# Tests

- `test/*.test.ts`: unit and component tests.
- `test/scenarios/*.test.ts`: scenarios. Each one drives a disposable Pnyx through the real `pnyx-axi` commands, the real server and the real saved files, with fake agents.
- `test/fixtures/`: synthetic inputs. `fixtures/agents/` holds the recorded agent sessions the fakes replay.

Run the scenarios after a build, one file at a time:

```sh
pnpm build
node --test --test-concurrency=1 "test/scenarios/*.test.ts"
```

`pnpm verify` picks what to run from the files the branch changes (see the root README).

## Writing a scenario

```ts
const pnyx = scenarioGroup()           // one Pnyx for the file: temp PNYX_HOME, random port, fake agents

test('…', async () => {
  const s = await pnyx.scenario()       // a fresh Hydra of its own, created with `pnyx-axi hydra create`
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

- `s.owner` / `s.ownerRefused` run `pnyx-axi` as the owner; `s.as({ agent }).run` / `.refused` run it with the environment Pnyx gave that agent, so its identity is its own. A refusal returns the error `code`.
- `s.agent({ cwd })` is the worker session started in that folder, `s.agent({ hydra: true })` the Hydra's. `s.received({ cwd })` is every message the agents there got, across restarts.
- `openPage` is the owner's page over the WebSocket: `shows` waits until its state passes a check, `command` sends a command and returns its receipt.
- `s.state()`, `s.task({ key })` and `s.events()` read the Hydra's saved files.

Rules:

- Wait with `until` (or `shows`) on something observable. No fixed sleeps, and no retries: a test that fails now and then is a bug.
- At most two heavy processes at once: the test process (which runs the server) and one awaited `pnyx-axi`. The Codex fake runs inside the test process.
- Nothing outside the scenario's temporary folder: never run `pnyx-axi setup`, never a real agent, terminal or GitHub.

## The fake agents

`fake-agents.ts` replays real sessions: each message a fake Claude Code gets starts the recorded Agent SDK turn again, and the fake Codex app-server answers each request with its recorded result and notifications. Pnyx's own provider code reads that output, so a change in what the agents send shows up here.

After upgrading the Agent SDK (pinned to one exact version in `package.json`) or Codex, run `pnpm refresh-agent-fixtures`. It records one short real turn of each with your logins in a temporary folder, without your settings or hooks, and saves only what Pnyx reads. `agent-pins.test.ts` fails while the recording is from another SDK version, or when Pnyx uses a Codex method the recorded Codex protocol does not have.
