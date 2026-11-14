# Tests

- A `*.test.ts` beside the code it covers is a unit test, only for tricky pure logic: parsers, dispatch rules, the store rebuild and similar.
- `e2e/*.test.ts`: flows. Each one walks a user journey through the real `pnyx-axi` commands, the real server and the real saved files, with fake agents, checking along the way. The default suite also runs the headless chat regression described below. Other page changes still need a local preview and pull request screenshots. The optional clipboard regression below exercises native browser editing.
- `fixtures/` beside the code: synthetic inputs. `src/test-harness/recordings/` holds the recorded agent sessions the fakes replay.

Run the flows after a build (`scenarios` is the launcher's name for the `e2e/` lane):

```sh
pnpm build
node scripts/verification/test.ts scenarios
```

`pnpm test` and `pnpm verify` use the same isolated launcher. Each run starts one throwaway PostgreSQL cluster, from the newest version 15 or newer in Homebrew's `postgresql@<n>` kegs or `/usr/lib/postgresql/<n>`, with logical replication on a random port and passes its `PGHOST`, `PGPORT` and `PGUSER` to every test. Each test file has its own temporary HOME, PNYX_HOME and harness directories, disabled external integrations and a guarded executable PATH. Actor, Hydra, task, port and model settings from the calling shell are discarded. Nothing else is inherited; PATH contains the guard scripts, the running Node installation and system tools. Checked pure files run four at a time and process and Git files two at a time, each file in its own process. The flows in `e2e/` run one at a time in a single process, so they share one server. The own-install flows run separately from a disposable installed checkout, using static imports of its built server and a throwaway Git origin. Each test fails by name after its lane's cap, and only one full run at a time holds the machine-wide lock.

On macOS a Chrome started with that temporary HOME finds no login keychain, and macOS then asks the owner on screen to create one. The launcher and the scenario harness therefore add `--use-mock-keychain` and `--password-store=basic` to every Chrome their process starts with `spawn`, `execFile`, `spawnSync` or `execFileSync` without a shell. They leave a Chrome started through a shell (`exec`, `execSync` or `shell: true`) untouched and cannot see one started by another program, such as the `chrome-devtools-axi` bridge; those callers add `KEYCHAIN_FLAGS` from `src/test-harness/chrome-keychain.ts` to the browser's arguments themselves.

For a small batch, pass explicit paths: `node scripts/verification/test.ts src/tasks/reminders.test.ts`.

The launcher fails a suite on `MaxListenersExceededWarning`, including warnings from the shared flow server. A passing run must release its listeners rather than raise their limit.

`pnpm verify` picks what to run from the files the branch changes (see [Development](development.md)).

## Chat streaming and replay

Install Google Chrome before running the full suite. `scripts/browser/chat-stream.test.ts` runs through the normal test launcher, including `pnpm test`, `pnpm verify` and CI. It uses pinned development dependencies for `chrome-devtools-axi` and its MCP server, an isolated headless browser, a random bridge port, a temporary home, and the existing recorded Claude fixture. It never attaches to an existing browser. Because the page reads Pnyx's data through Zero, the browser suites start their server with zero-cache (`scenarioGroup({ zeroCache: true })`); the other flows run without it. The Ubuntu 24.04 CI image includes Chrome; see its [installed software](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md#browsers-and-drivers).

The fixture holds after a known partial delta. The check verifies the server's page socket received that exact text and the real page painted it before release. It then covers native transcript handoff, commentary in progress with tool calls hidden by Focus mode, the final text, duplicate or missing rendered rows, server restart with reconnect, and switching between Hydras without painting another conversation. It also checks that the page logs how long Hydra's reply took to show its first text after the owner's send (`page.first-text`), and that the server writes that line with `source: web`. A second check holds the owner's send inside the page to prove the message and working dots show before the server answers, then covers the running dot in the Hydra list, tool calls inside progress with plain labels that open to their input, Focus mode hiding them during the turn, and a refused send kept as not sent and retried once. Run it after a build with `node scripts/verification/test.ts scripts/browser/chat-stream.test.ts`.

The draft flow checks browser-owned text, deleting a moved chip with native Backspace, reload before the save pause, malformed stored comments, sending the latest unpaused comment with its draft, clearing sent drafts across reloads, and saving under the canonical identity after a pending Hydra is confirmed. Two real tabs cover simultaneous independent saves against the same prior list, one-time migration to per-comment keys, malformed record events, rejected writes, preserving local edits and removals, deletion while a stale tab saves another comment, and restoring comments in both tabs. Draft-store tests control the save timer and keep failed writes dirty until persistence succeeds.

The status flow first records an older native call, then holds the real Claude adapter during current thinking and a Bash call before its native record is written. It checks the page's Thinking and Running a command labels, the final reply and the timer ending. The client-recovery regression holds the socket budget above its limit, then drains it without another content change. It checks sparse message and action updates, explicit removals, and the latest batch a tab gets when it opens or releases a hidden card.

The long-reply contract replays text deltas recorded from a synthetic Codex reply containing Markdown lists and code through the fake Claude session and the real provider adapter. The reply crosses 60 live transport parts before native completion. An animation-frame probe checks the text revealed by CSS highlights, ignoring message controls and whitespace. It fails if revealed text shrinks or changes, the reply appears twice, or the row remounts during native handoff. The completed live page and a fresh page must match the recorded visible text; the server projection and native transcript must match the full reply. `src/test-harness/chat-contract.ts` provides the same probe for isolated real-agent validation. CI uses recorded data and needs no agent credentials.

The conversation-delivery regression exercises the real socket-budget guard with a controlled network client. It rejects the final page, drains the buffer without another content change, and checks eventual delivery, replacement by a newer pending page, resync, socket close and reconnect. Clock control makes recovery assertions independent of machine speed.

`src/hydra/message-window.test.ts` checks that a conversation without a transcript opens on its newest 20 messages, reads every earlier page and keeps its reach when read again. The browser flow `a long conversation opens on its newest page…` checks that scrolling up reads the older pages by itself without moving the message being read. Thread-delta tests cover entry additions, updates and removals, retained object identity, native ordering, fold and timing changes, duplicate delivery and recovery from a version gap. The connection-store regression keeps the last valid conversation while requesting resync, then accepts the replacement page. Explicit read receipts remain full pages; the scenario harness applies pushed deltas with the same receiver as the page. The subscription flow also expands four source pages, resets to three, checks eviction on later arrivals, reloads Older, holds eviction while reading, and supersedes a held trim with a newer Older read. Receive tests preserve a range the owner has begun reading; stream-key tests prune evicted mappings without changing a retained long reply's key. For a development browser check, reload an evicted comment source and confirm its passage is in the viewport; explicit passage navigation must cancel following before it scrolls. Hold the source read and trigger a layout scroll near the bottom: following must stay off until real owner input or Jump to latest resumes it. Return with a real downward wheel gesture or End and confirm layout shifts do not undo following; the first reveal after loading must focus the note and show its quote without a second click.

`scripts/browser/page-rows.test.ts` reads the rows a page gets through `/zero` with the page's cookie, without a browser: a hidden task's reference carries its status for chips and leads, and no frame carries a card's private steering. `src/store/schema.test.ts` and `src/store/postgres.test.ts` check that the publication holds only what the page reads, new or migrated, and `src/app/zero-cache.test.ts` that a replica built under the older, larger publication keeps serving after the migration. A card's Updates come a page at a time from the server (`e2e/history-pages.test.ts`). `src/app/zero-cache.test.ts` checks that zero-cache listens on loopback only, that a client skipping `/zero` gets no rows, that a wrong cookie is refused and that zero-cache comes back after it dies. Row checks in `web/src/app/hydra-rows.test.ts` cover hidden tasks kept as references for prerequisites, waits and answer leads. The socket checks cover cached reply and usage recovery when a card comes back and latest batches for interests that change the shown cards. Socket page commands reject Hydra overrides. Request tests hold confirmation ahead of the page sequence so a task edit and Hydra agent selection keep their previews. The focused streaming browser flow also opens a hidden task from a chat chip and restores its expanded detail after reload, then checks the refusal after the referenced task moves away. Chat-queue checks cover started receipts, kept only for the owner's messages and capped at the newest 32.

Oracle regressions in `src/oracle/index.test.ts` check that event batches commit with their cursor, so a retry after a failed read resumes after them, that a replaced Hydra removes the retired index and rebuilds the cache, that an unchanged query succeeds while another connection holds the cache write lock, and that an incompatible cache version rebuilds from durable sources without touching the Hydra.

History checks read Hydra's replies from the native transcripts of every session it was configured with, exclude its tool and thinking records, and bound each reply by the log events around it.

## Native clipboard regression

With `playwright-axi` installed and its Chromium browser available, run `pnpm build` followed by `node --conditions=source --test scripts/browser/composer-paste.ts`. This opt-in check uses the existing scenario harness, a temporary home and a random port, and closes its own browser session. It covers the task brief, the task-card answer note and the Hydra reply through the shared composer: native multiline clipboard paste, text/image preference, image upload, selection/copy, keyboard edits, browser text insertion, IME composition and persisted submission. It uses Chromium's native editing command because headless macOS keyboard shortcuts alone do not reliably trigger paste. The real OS dictation service and other browser engines need a manual trial.

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
- `openPage` is the owner's page over the WebSocket: `shows` waits until the server's state of the Hydra passes a check, `command` sends a command and returns its receipt, `refusal` one the server refuses and returns its error.
- `s.state()`, `s.task({ key })` and `s.events()` read the server's state of the Hydra and its saved events.
- `s.owner({ args, input })` pipes `input` into the CLI, including `reply --file -`.
- `page.queue()`, `page.upgrade()` and `page.settings()` read the rows the page reads through Zero: the Hydra's `hydras.queue` (waiting and reading batches and Hydra's chat queue), `upgrade_status` and the shared `settings`.
- `page.threads` records the thread pages the server pushes to a tab subscribed with the `thread` command.
- `pnyx.restart()` keeps the port, so an open page reconnects to the new server. Flows run one at a time, so a restart never cuts into another flow.

Rules:

- Wait with `until` (or `shows`) on something observable. No fixed sleeps, and no retries: a test that fails now and then is a bug. `until` stops on any value but `undefined` and `false`, so a count waits as `length > 0`.
- The server reads each write on its own schedule, and builds the routine helper's next batch and Hydra's next wake only from what it has read. It sends each event to open pages in the same step, so release a held turn that must see a write once an open page shows that event's `seq`.
- At most two heavy processes at once: the test process (which runs the server) and one awaited `pnyx-axi`. The Codex fake runs inside the test process.
- Nothing outside the scenario's temporary folder: never run `pnyx-axi setup`, never a real agent, terminal or GitHub.

## The fake agents

`src/test-harness/fake-agents.ts` replays real sessions: each message a fake Claude Code gets starts the recorded Agent SDK turn again, and the fake Codex app-server answers each request with its recorded result and notifications. Pnyx's own provider code reads that output, so a change in what the agents send shows up here.

After upgrading the Agent SDK (pinned to one exact version in `package.json`) or Codex, run `pnpm refresh-agent-fixtures`. It records one short real turn of each with your logins in a temporary folder, without your settings or hooks, and saves only what Pnyx reads.

For a controlled turn, `pnyx.claude.plan({ text, reply, hold })` matches the next prompt ending in `text` that reaches an agent of the Hydra whose scenario made the plan, and replays the recording with the chosen reply. Another flow's agents never take it, even if it goes unused. A held turn streams its text and waits before the completed assistant message; call the returned `release()` in `finally`. `plan` also accepts `match({ text })` to select a turn by the command or skill it requests, without matching wake copy. `pnyx.claude.plan` also takes `before` and `after`: native messages, such as compaction statuses, sent ahead of the recorded turn; a held plan waits between them. `pnyx.codex.plan({ text, hold: true })` holds the recorded turn's output until released and accepts owner steering while it waits. These controls never start an outside agent.

`pnyx.claude.plan` also accepts `stream`, an `AsyncIterable<string>` that replays its yielded chunks as text deltas instead of `partial`. The joined chunks must remain a prefix of `reply`. A held plan waits after the final chunk, before native completion.

The flows:
- `tasks.test.ts` covers a task's life, column rules and dependencies.
- `hydra.test.ts` covers Hydra messages and the queue.
- `questions.test.ts` covers permission requests and report choices.
- `steering.test.ts` covers steering a worker, the steering inbox and external sources.
- `landing.test.ts` covers landing a branch or a pull request and project refresh.
- `settings.test.ts` covers the settings every Hydra shares: a change from one Hydra reaching another Hydra's open page, while each board keeps its own layout.
- `helper.test.ts` covers the routine helper's routing: progress that wakes nobody, batches while main works, capped batches and a failed batch's hand-back.
- `recovery.test.ts` covers restart and recovery, including interrupted worker turns.
- `oracle.test.ts` covers Oracle queries from the page: queries see new tasks immediately, new queries cancel superseded searches, filters and validation agree between the page and CLI, and a hosted worker's finished turn copies nothing from its transcript into the log or wakes `hydra check`, whose `conversations` hold the owner's queued reply.
- `upgrade.test.ts` covers `/upgrade` against the flows' throwaway Pnyx folder (`pnyx.upgrade`): a build that runs while Hydra works, a failed build, Stop, the wait for agents on any Hydra to be between turns, Restart now, messages sent during the restart and a failed restart, which the flows count with `pnyx.restarts()` and finish with `pnyx.restart()`. It also covers `pnyx-axi upgrade` handed to the server from a terminal, `pnyx-axi upgrade --stop` followed by an upgrade that finishes, and the chat's milestone line in each state. It also covers a second Hydra's upgrade refused while one waits, and the command refused for a Hydra the server does not run. `own-install.test.ts` runs `pnyx-axi upgrade` and `upgrade --stop` with the server stopped, against its disposable install. A failed build in the upgrade a terminal runs with no server is covered beside the code, in `src/upgrade/upgrade.test.ts`, against its own throwaway folder.
- `native-session.test.ts` exercises the real provider adapters with synthetic native input and output: queued and carried work, background tasks, reader detach, permission receipts and complete terminal outcomes.
- `native-idle.test.ts` runs the real application host in an isolated child with a controlled clock, proving the idle deadline and original-image admission through compaction and upgrade buffers.
- `native-settings.test.ts` checks that a rejected live setting defers stale-session retirement until queued, background and unknown native work settles.
- `compaction.test.ts` covers compaction. Through the real CLI and server it sends Claude Code's repeated status during one long `/compact` and a compaction followed straight by another; an isolated child with a controlled clock checks that a silent or unanswered compaction fails at its deadline, even while another writer holds the lock, that late statuses keep its one operation, and that held input waits through a second compaction started after a pause. Each case checks that a message sent meanwhile waits in Hydra's queue and reaches Hydra once, in the recap after the compaction.
- `agent-input.test.ts` uploads images and sends them through the real CLI and server into both native provider formats.
- `send-latency.test.ts` measures how long a send takes from the page to the fake agent; it runs only with `PNYX_LATENCY=1`.
- `logs.test.ts` covers the diagnostic logs: each action's line and its fields, the lines a chat turn, its live thread and a project read write, the Off and Detailed levels, lines a page sends, cleanup by days and size, `logs clean`, a restart's lines and `debug performance`. The flows' server writes its process line every 200 ms instead of every 30 seconds, and `logLines()` reads every line back. The flows' agents are fakes without a process, so `src/workers/agent-memory.test.ts` covers the agent memory line with a real child process and its tool.

The in-process provider contracts and their current limits are described in [Provider sessions](provider-sessions.md).

When a test lane fails, the launcher retains its scratch Postgres log outside the deleted test home and prints the path and its last lines. The cluster logs lock waits and omits parameter values on SQL errors, so a timeout can be traced to the actual statement and blocking process without dumping event bodies.
