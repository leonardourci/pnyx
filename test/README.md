# Tests

- `test/*.test.ts`: unit and component tests.
- `test/scenarios/*.test.ts`: scenarios. Each one drives a disposable Pnyx through the real `pnyx-axi` commands, the real server and the real saved files, with fake agents.
- `test/fixtures/`: synthetic inputs. `fixtures/agents/` holds the recorded agent sessions the fakes replay.

Run the scenarios after a build, one file at a time:

```sh
pnpm build
node --test --test-concurrency=1 "test/scenarios/*.test.ts"
```

`pnpm verify` picks what to run from the files the branch changes (see [Development](../docs/development.md)).

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

- `s.owner` / `s.ownerRefused` run `pnyx-axi` as the owner; `s.as({ agent }).run` / `.refused` run it with the environment Pnyx gave that agent, so its identity is its own. A refusal returns the error `code`; `s.ownerRefusal` / `.refusal` return `{ code, error }`.
- `s.chat({ text })` is the owner writing in Hydra's chat, which starts Hydra; it returns Hydra's session once Hydra heard it. Hydra exists only after a chat message or a worker's report.
- `s.agent({ cwd })` is the worker session started in that folder, `s.agent({ hydra: true })` the Hydra's. `s.received({ cwd })` is every message the agents there got, across restarts. A fake Claude session's `useTool({ tool, input })` asks for a tool's permission as Claude Code does mid-turn and resolves with Pnyx's decision.
- `s.project({ name, flags })` is a git project with its own bare origin, attached with `project add`; tasks in it start in their own copies. `s.pullRequest({ number, state, draft, checks, comments })` sets what the fake `gh-axi` reports for a pull request of the scenario's repository and returns its URL; the server reads followed pull requests every 100 ms. `s.merges({ number })` counts the merges `task merge` asked for.
- `openPage` is the owner's page over the WebSocket: `shows` waits until its state passes a check, `command` sends a command and returns its receipt.
- `s.state()`, `s.task({ key })` and `s.events()` read the Hydra's saved files.
- `s.owner({ args, input })` pipes `input` into the CLI, including `reply --file -`.
- `page.queues` records the server's worker-update queue messages, including waiting and reading batches.
- `pnyx.restart()` keeps the port, so an open page reconnects to the new server.

Rules:

- Wait with `until` (or `shows`) on something observable. No fixed sleeps, and no retries: a test that fails now and then is a bug. `until` stops on any value but `undefined` and `false`, so a count waits as `length > 0`.
- At most two heavy processes at once: the test process (which runs the server) and one awaited `pnyx-axi`, plus one headless Chrome in a browser journey file. The Codex fake runs inside the test process.
- Nothing outside the scenario's temporary folder: never run `pnyx-axi setup`, never a real agent, terminal or GitHub.

## Browser journeys

`browser.ts` starts one headless Chrome for a file (`browserGroup()`, next to `scenarioGroup()`), with a temporary profile, talking to it over a pipe. `page-journeys.test.ts` is the owner's core journeys on the built page: chat, the composer, a card's Updates and answering a question.

```ts
const chrome = browserGroup()
const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
await page.click({ selector: '.hydra-chat textarea' })
await page.type({ text: 'Plan the release' })
await page.press({ key: 'Enter' })
await page.shows({ what: 'the reply', check: () => document.querySelector('.messages')?.textContent?.includes('Friday') })
await page.close()                    // fails if the page threw
```

- `shows` runs its check in the page until it returns something truthy, and returns that. The check is sent as source, so it sees only its `arg` and the page.
- `click` is a real mouse click on the first visible match (narrowed by `text`), once nothing covers its centre; `upload` picks files in a file input.
- Check what the owner sees once it has settled, not a passing moment: a state that lasts only until a timer or an animation ends makes the test depend on the machine.
- Chrome comes from `PNYX_CHROME` or its usual install path. Browser journeys run with the UI checks in `pnpm verify`.

## The fake agents

`fake-agents.ts` replays real sessions: each message a fake Claude Code gets starts the recorded Agent SDK turn again, and the fake Codex app-server answers each request with its recorded result and notifications. Pnyx's own provider code reads that output, so a change in what the agents send shows up here.

After upgrading the Agent SDK (pinned to one exact version in `package.json`) or Codex, run `pnpm refresh-agent-fixtures`. It records one short real turn of each with your logins in a temporary folder, without your settings or hooks, and saves only what Pnyx reads. `agent-pins.test.ts` fails while the recording is from another SDK version, or when Pnyx uses a Codex method the recorded Codex protocol does not have.

A fake Claude session also records the media type of each image it received in `images`.

For a controlled turn, `pnyx.claude.plan({ text, reply, hold, fail })` matches the next prompt ending in `text`. It replays the recording with the chosen reply, or throws the chosen provider error. A held turn streams its text and waits before the completed assistant message; call the returned `release()` in `finally`. `pnyx.codex.plan({ text, hold: true })` holds the recorded turn's output until released and accepts owner steering while it waits. These controls never start an outside agent.

`hydra.test.ts` covers owner chat and restart, failure recovery, queued message settings and tagged Updates, progress and question wakes, mid-turn steering and report batches, quiet replies, memory refresh, and Lavish feedback sent to its worker. The older tests for progress validation and batching, queued owner settings, busy-turn batching, quiet reply filtering and shared owner preferences are replaced by these journeys. Specialized stall, timer, permission, migration and interrupted-turn tests remain until scenarios cover their distinct guarantees.
