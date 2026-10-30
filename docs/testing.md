# Tests

- A `*.test.ts` beside the code it covers is a unit test, only for tricky pure logic: parsers, dispatch rules, the store rebuild and similar.
- `e2e/*.test.ts`: flows. Each one walks a user journey through the real `pnyx-axi` commands, the real server and the real saved files, with fake agents, checking along the way. The default suite has no browser tests: check a page change in the local preview and the pull request's screenshots. The optional clipboard regression below exercises native browser editing.
- `fixtures/` beside the code: synthetic inputs. `src/test-harness/recordings/` holds the recorded agent sessions the fakes replay.

Run the flows after a build (`scenarios` is the launcher's name for the `e2e/` lane):

```sh
pnpm build
node scripts/verification/test.ts scenarios
```

`pnpm test` and `pnpm verify` use the same isolated launcher. Each test file has its own temporary HOME, PNYX_HOME and harness directories, disabled external integrations and a guarded executable PATH. Actor, Hydra, task, port and model settings from the calling shell are discarded. Nothing else is inherited; PATH contains the guard scripts, the running Node installation and system tools. Checked pure files run four at a time and process and Git files two at a time, each file in its own process. The flows in `e2e/` run one at a time in a single process, so they share one server. The own-install flows run separately from a disposable installed checkout, using static imports of its built server and a throwaway Git origin. Each test fails by name after its lane's cap, and only one full run at a time holds the machine-wide lock.

For a small batch, pass explicit paths: `node scripts/verification/test.ts src/tasks/reminders.test.ts`.

`pnpm verify` picks what to run from the files the branch changes (see [Development](development.md)).

## Native clipboard regression

With `playwright-axi` installed and its Chromium browser available, run `pnpm build` followed by `node --conditions=source --test scripts/browser/composer-paste.ts`. This opt-in check uses the existing scenario harness, a temporary home and a random port, and closes its own browser session. It covers the task brief, the task-card answer note and the chat Merge/Hold answer through the shared composer: native multiline clipboard paste, text/image preference, image upload, selection/copy, keyboard edits, browser text insertion, IME composition and persisted submission. It uses Chromium's native editing command because headless macOS keyboard shortcuts alone do not reliably trigger paste. The real OS dictation service and other browser engines need a manual trial.

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
- `openPage` is the owner's page over the WebSocket: `shows` waits until its state passes a check, `command` sends a command and returns its receipt, `refusal` one the server refuses and returns its error.
- `s.state()`, `s.task({ key })` and `s.events()` read the Hydra's saved files.
- `s.owner({ args, input })` pipes `input` into the CLI, including `reply --file -`.
- `page.queues` records the server's worker-update queue messages, including waiting and reading batches.
- `pnyx.restart()` keeps the port, so an open page reconnects to the new server. Flows run one at a time, so a restart never cuts into another flow.

Rules:

- Wait with `until` (or `shows`) on something observable. No fixed sleeps, and no retries: a test that fails now and then is a bug. `until` stops on any value but `undefined` and `false`, so a count waits as `length > 0`.
- The server reads each write on its own schedule, and builds the routine helper's next batch and Hydra's next wake only from what it has read. It sends each event to open pages in the same step, so release a held turn that must see a write once an open page shows that event's `seq`.
- At most two heavy processes at once: the test process (which runs the server) and one awaited `pnyx-axi`. The Codex fake runs inside the test process.
- Nothing outside the scenario's temporary folder: never run `pnyx-axi setup`, never a real agent, terminal or GitHub.

## The fake agents

`src/test-harness/fake-agents.ts` replays real sessions: each message a fake Claude Code gets starts the recorded Agent SDK turn again, and the fake Codex app-server answers each request with its recorded result and notifications. Pnyx's own provider code reads that output, so a change in what the agents send shows up here.

After upgrading the Agent SDK (pinned to one exact version in `package.json`) or Codex, run `pnpm refresh-agent-fixtures`. It records one short real turn of each with your logins in a temporary folder, without your settings or hooks, and saves only what Pnyx reads.

For a controlled turn, `pnyx.claude.plan({ text, reply, hold })` matches the next prompt ending in `text` that reaches an agent of the Hydra whose scenario made the plan, and replays the recording with the chosen reply. Another flow's agents never take it, even if it goes unused. A held turn streams its text and waits before the completed assistant message; call the returned `release()` in `finally`. `pnyx.claude.plan` also takes `before` and `after`: native messages, such as compaction statuses, sent ahead of the recorded turn; a held plan waits between them. `pnyx.codex.plan({ text, hold: true })` holds the recorded turn's output until released and accepts owner steering while it waits. These controls never start an outside agent.

The flows:
- `tasks.test.ts` covers a task's life, column rules and dependencies.
- `hydra.test.ts` covers Hydra messages and the queue.
- `questions.test.ts` covers permission requests and report choices.
- `steering.test.ts` covers steering a worker, the steering inbox and external sources.
- `landing.test.ts` covers landing a branch or a pull request and project refresh.
- `settings.test.ts` covers the settings every Hydra shares: a change from one Hydra reaching another Hydra's open page, while each board keeps its own layout.
- `helper.test.ts` covers the routine helper's routing: progress that wakes nobody, batches while main works, capped batches and a failed batch's hand-back.
- `recovery.test.ts` covers restart and recovery, and a server that goes idle once nothing changes.
- `oracle.test.ts` covers Oracle queries from the page: a query waits for the index only when it is missing or behind the log, a change catches it up without a query, and a catch-up that fails reaches the page as an error.
- `upgrade.test.ts` covers `/upgrade` against the flows' throwaway Pnyx folder (`pnyx.upgrade`): its place in Hydra's queue, a failed build, Stop, messages sent during it and the restart, which the flows count with `pnyx.restarts()` and finish with `pnyx.restart()`.
- `native-session.test.ts` exercises the real provider adapters with synthetic native input and output: queued and carried work, background tasks, reader detach, permission receipts and complete terminal outcomes. It proves the provider inventory used by both ownership modes.
- `native-idle.test.ts` runs the real application host in an isolated child with a controlled clock, proving the idle deadline and original-image admission through compaction and upgrade buffers.
- `native-settings.test.ts` checks that a rejected live setting defers stale-session retirement until queued, background and unknown native work settles.
- `compaction.test.ts` covers compaction. Through the real CLI and server it sends Claude Code's repeated status during one long `/compact` and a compaction followed straight by another; an isolated child with a controlled clock checks that a silent or unanswered compaction fails at its deadline, even while another writer holds the lock, that late statuses keep its one operation, and that held input waits through a second compaction started after a pause. Each case releases the messages held during the compaction.
- `native-process.test.ts` exercises the provider spawn hooks with real children, checking private process groups and stderr pressure through the Claude hook.
- `agent-host-group.test.ts` checks cleanup of verified old provider/tool members and saved-session resume even when identity or the legacy cutoff is unknown.
- `agent-host-steering.test.ts` proves that a pending durable inbox rings once after host recovery, keeps its repeat warning and stays deduplicated after another app restart for both providers.
- `agent-host-epochs.test.ts` checks multiple closed epochs of one native session, preserving an older real outcome while acknowledging ended-only epochs, opening fresh work and surviving another restart without input replay.
- `agent-host-reboot.test.ts` checks kernel boot identity persistence, resume with same or unknown identities, and retained-fact settlement before cold resume.
- `agent-host.test.ts` exercises the authenticated native host in a real isolated subprocess: reconnect, request/input deduplication, controller takeover, critical replay and acknowledgements, secret receipts, pressure, singleton discovery and host-loss refusal.
- `agent-host-remote.test.ts` runs real CLI/server SIGKILL flows for Hydra and workers on both providers and tracks the separate helper replay gate. Late helper outcomes preserve an earlier error, survive a crash between application and acknowledgement, recover missing journals even after the batch left active state, settle already-recorded malformed errors without reinterpreting them as new results, and refuse conflicting or expired input and missing, mismatched or ambiguous bindings.
- `agent-host-maintenance.test.ts` proves manual idle stop, carried input settlement, background/compaction blockers, unapplied-outcome protection, controller fencing and clean restart.
- `native-status.test.ts` checks status over the existing browser socket and secret re-entry after an app crash before native delivery.
- `native-startup.test.ts` checks first activation after an in-process server closes, including saved work and upgrade records, dead and invalid PIDs, refusal while the previous server is live, and reuse of the copied production SDK closure. It also checks recovery on the same application connection after SIGTERM and SIGKILL, selected-bundle reuse and exit logs, and records idle resources.
- `native-performance.test.ts` runs the opt-in full application comparison with `PNYX_NATIVE_BENCHMARK=1` in the isolated environment from `scripts/verification/test-environment.ts`. At one session, RPC p95/p99 must stay below 5/10 ms. At ten sessions, a fixture-only socket observer beside the host measures request-to-reply handling against the same limits, excluding application response scheduling stalls. Page and warm Hydra-send, worker-message and effort-setting receipt p95 regression must remain within 10 ms of the local baseline at both loads; every command must still return a receipt.
- `agent-host-bundle.test.ts` starts a host from copied runtime bytes and checks that rebuilding the source payload leaves its native owner and old bundle usable.
- `agent-input.test.ts` uploads images and sends them through the real CLI and server into both native provider formats.

The in-process provider contracts and their current limits are described in [Provider sessions](provider-sessions.md). The separate transport foundation and its integration limits are described in [Native agent host transport](agent-host.md).
