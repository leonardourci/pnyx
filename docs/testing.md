# Tests

The suite runs on [Vitest](https://vitest.dev). Most of it drives a real Othrys server the way its users do: the owner and the agents through the built `othrys`, the page through its resumed WebSocket. The browser checks open the real page in Chrome or in Playwright's Chromium and WebKit. Touch emulation covers pointer events and media queries. It does not show the native iOS selection menu or handles.

```text
tests/
├── <area>.test.ts      one file per area: its integration tests and its tricky edge cases
├── browser/            targeted checks in isolated headless browsers
└── setup/              the shared setup: scratch files, the server, fake agents, fixtures
```

## Running

The targeted browser checks require an installed Chrome and Playwright's Chromium and WebKit (`pnpm exec playwright-core install chromium webkit`); they launch their own headless session with a scratch profile and never attach to an existing browser. The harnesses use pinned `playwright-core` and `chrome-devtools-axi` development dependencies.

Run:

```sh
pnpm test                                   # builds, then runs everything
pnpm exec vitest run tests/chat.test.ts     # one file, after a build
pnpm exec vitest run --project integration  # the integration suite
pnpm exec vitest run --project browser      # targeted browser checks
pnpm exec vitest run tests/browser/status.test.ts # shared status across the page and CLI
pnpm exec vitest run -t "outside hooks"         # tests whose name matches
```

The tests run the built CLI and serve the built page, so run `pnpm run build` after changing code under `src/` or `web/` before a focused run. CI builds first.

Set `OTHRYS_KEEP_TEST_FILES=<folder>` to copy each run's scratch homes there before they are deleted; CI does this and uploads the folder when a run fails.

Each test file runs in its own process with a scratch `HOME` and `OTHRYS_HOME`, native files, a `PATH` whose `claude`, `codex`, `gh`, `gh-axi`, `paseo`, `firstmate`, `herdr`, `tmux`, `quota-axi`, `launchctl`, `systemctl` and `brew` fail loudly, none of the calling shell's identity or settings, and a 1 GB heap for every Node process it starts. Integration files run on half the cores, longest first, leaving CPU and memory for their child processes. Browser checks run afterward on a quarter of the cores. The tests in each file run in a random order: the run prints its seed, and `--sequence.seed=<seed>` repeats that order. The tests in one file share its server, so each test sets up what it needs and must pass alone and in any order.

## Writing a test

Every change to behaviour adds or updates the tests for it; documentation-only and behaviour-preserving changes need none. A bug fix starts with a test that reproduces the bug. Before the PR is ready, revert the behaviour change in a throwaway copy, run each new test of that behaviour and see it fail; the PR's Validation names the test and what failed.

Add to the area's file, or start a new `tests/<area>.test.ts` for a new area. A file starts its server once:

```ts
import { beforeAll, expect, test } from 'vitest'
import { startOthrys, until, type Othrys } from './setup/othrys.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test('a reply reaches the worker once', async () => {
  const titan = await othrys.titan()                       // a Titan of its own
  const folder = titan.folder({ name: 'app' })
  await titan.owner({ args: ['task', 'create', '--title', 'Ship it', '--key', 'ship', '--folder', folder] })
  await titan.owner({ args: ['task', 'start', 'ship'] })
  const worker = await titan.agent({ cwd: folder })       // the fake agent Othrys started there
  await titan.owner({ args: ['reply', 'ship', '--text', 'Update the install guide'] })
  await until({ what: 'the reply', check: () => worker.received.some(text => text.includes('Update the install guide')) })
})
```

- `titan.task({ key })` reads a task as `task show` prints it, and `titan.startTask({ key, harness })` creates a task, starts its worker and waits for the worker's first turn.
- `titan.owner({ args, input })` calls internal server operations as the owner and returns their structured receipts; `titan.ownerRefused` returns a refusal's `code` and `error`. `titan.as({ session }).run` and `.refused` call them with the identity Othrys gave that agent.
- `titan.chat({ text })` is the owner writing in Titan's chat; it resolves with Titan's session once Titan heard it. `titan.agent({ cwd })` waits for the worker Othrys started in a folder.
- `titan.page()` opens the owner's page socket; `page.send({ name, args })` sends a command as the page does and resolves with its receipt or error.
- Check persistence by restarting and reading through the CLI or page. Page assertions read `othrys.home()` or `openHomePage` through the real home socket.
- `othrys.restart({ whileStopped })` stops the server and starts it again on the same home and port.

Rules:

- Assert what a user can observe: CLI output and refusals, the page's receipts and rows, what an agent received, saved events. Never source text, private helpers or snapshots.
- Check the refusal's `code`, and at most one fact of its text; never a whole English sentence.
- Wait with `until` on an observable condition. No fixed sleeps and no retries: a test that fails now and then is a bug.
- Use the IDs a command returned. Expected values are written out, not computed.
- Edge cases of tricky logic go in the same area file, calling the function directly only when the server cannot reach the case cheaply.
- No duplicate, cosmetic or snapshot tests, and none that break on a rename that keeps behaviour. A new case that fits an existing test becomes assertions in it, and a flow that differs only in its input runs once with an assertion per input.
- A file starts one server. A test starts a server of its own only when starting or stopping that server is what it proves.
- A browser check in `browser/` earns its place only for what needs a real page, such as rendering or scrolling, and guards one behaviour. It waits on real state: the page's rows, its socket frames or a number of painted frames, never a timer.
- A wait on one of the server's intervals shortens that interval through the server's option (`followDelay`, `queueDelay`), never by raising the wait's bound.
- Nothing outside the test's scratch folders: never a real home, agent, terminal or GitHub.
- A test that pins a known bug is wrong; skip it with a note naming the task that fixes the bug. `tests/hooks.test.ts` holds one such skipped case.
- A hook, or any command a harness waits on, is judged by its outcome (it ended by itself, exit code, output), never by a wall-clock bound.

## The fakes

`setup/agents.ts` replays one real recorded turn of Claude Code (through the Agent SDK) and Codex (its app-server) from `setup/fixtures/agents/`, so Othrys's provider code runs over what the agents really send. `othrys.claude.plan({ titan, text, reply, partial, hold })` shapes the next turn whose prompt ends with `text` (or the one `match` accepts): its reply, a streamed prefix and whether it waits for `release()`. `othrys.codex.plan` also takes `refuse`, which makes the app-server answer that turn's start with an error, so Othrys sees the agent refuse the message. `compactTo` compacts a turn to that many tokens: a Claude turn planned with `compacting` finishes the compaction at once and ends as `/compact` does once released, and a Codex turn compacts just before it ends. A Claude plan's `window` is the context window Claude Code reports from that turn on, as after a model switch. A Claude plan's `folds` takes each message sent while that turn runs into the turn at once and records it as Claude Code does: a `queued_command` attachment and an `absorbed_mid_turn` queue removal, with no user line. `othrys.claude.context` and `othrys.codex.context` hold the context the recorded turn reports. `othrys.claude.models.list` is the model list Claude Code reports, and setting `othrys.claude.models.failure` makes every model list read fail with that message until it is cleared. A held Claude turn also ends when Othrys stops it. A fake Claude session's `useTool({ tool, input })` asks for a tool's permission as Claude Code does mid-turn, and a Claude plan's `tool` makes the turn call that tool first and keep running it until the turn's release. `setup/transcripts.ts` appends records to a Claude session's transcript, as Claude Code writes them. After upgrading the Agent SDK or Codex, run `pnpm refresh-agent-fixtures` to record a fresh turn of each.

`setup/fixtures/gh-axi.mjs` stands in for `gh-axi`: set `OTHRYS_GH_AXI` to it and `OTHRYS_FAKE_GITHUB` to a folder holding `<owner>/<repo>/<number>.json` pull requests (`state`, `checks`, `head`, `draft` and `mergeBehavior`, `merged` or `queued`). It answers merge requests too and logs every call in `calls.jsonl`. The quota fake reports a login folder holding a file named `exhausted` as out of quota, and a missing folder as signed out. `setup/upgrade.ts` makes a throwaway Othrys folder with its own origin, whose commits decide whether install or build fails.

## What each file covers

- `access.test.ts`: agent command notices, the guard against self-approval, Titan's own permission requests, the page's token, socket, `/api/run` and image files.
- `socket-state.test.ts`: ordered home changes, snapshot fallback, unchanged card identity and exclusion of private steering.
- `chat.test.ts`: Titan's chat, the queue, the routine helper's task lease, Stop, once-only delivery, resuming after a restart, and that Titan's folder holds the shipped skills.
- `hooks.test.ts`: outside sessions reporting through the installed hook, with the server up or down.
- `oracle.test.ts`: search, its project and date filters and what it never reads.
- `paging.test.ts`: chat pages and a card's Activity pages.
- `pickers.test.ts`: `models --refresh` asking the harness again and keeping its list when that fails; how suggestion lists rank their matches and mark each matched character once; `files` listing each project's files without ignored ones or nested repositories, and again after they change; a folder listing that names every entry when asked for files; how a typed name narrows that listing and its recent folders before at most eight recent ones show, what a missing folder lists, and when Tab completes from it.
- `projects.test.ts`: task copies, both landing rules and the merge gate.
- `handoffs.test.ts`: queued worker handoffs, checkout refusals and crash recovery in a separate scratch home.
- `settings.test.ts`: the settings every Titan shares.
- `native-store.test.ts`: durable receipts, task folder moves, corrupt logs, permission recovery and read-only setup.
- `tasks.test.ts`: the Titan's tasks, dependencies, holds, undo and `apply`.
- `upgrade.test.ts`: `/upgrade`, its checkout notices, its rollback and its restart.
- `verification.test.ts`: which local commands, CI checks and review instructions a change's paths select, and the staged build.
- `worker-scope.test.ts`: workers can change other tasks and settings with scope notices, whichever way they were started, and retain their own reporting and read access.
- `workers.test.ts`: starting workers and choosing their account, replies and refused answers, permissions, resumed turns and context readings through compactions and restarts, on Claude and Codex.
- `card-input.test.ts`: sending from a card straight to its worker, interrupting sends and harness or model changes, Stop, retries and restart recovery.
- `ui-metrics.test.ts`: the page's bounded, aggregated performance measurements and Logs Off.
- `browser/chat.test.ts`: both chats interrupt and deliver sends through either provider, retain sent bubbles through held operations and refused deliveries, retry the same message, render task references as live chips, and keep Stop silent. They open on their latest row and retain the visible rows through older-page loading and Retry. Focus mode keeps tool names out of the working line, and a card's status never names one.
- `browser/cards.test.ts`: every column and card stays mounted through horizontal and vertical scrolling at desktop and phone widths, project requests reveal their column, Activity loads and retains all update rows and receives live changes, an open card fills its column after a viewport resize, and starting its worker keeps one stored card and the same DOM node.
- `browser/comments.test.ts`: in Chromium and WebKit, wide and at phone size, the bar above the composer and the pill by the selection comment on and quote the selected text when pressed; on touch the pill sits clear of the selection handle, and both keep the passage when the selection drops until a tap lands elsewhere.
- `browser/composer.test.ts`: the caret is drawn right after the last letter typed past chips, wide and at phone size. Arrows, Shift+arrows, Backspace, Delete and a chip's × treat each chip as one unit, and an @ or / right after a chip opens its picker. The message keeps every chip's Markdown through copy, paste, cut, Undo, Redo and new lines; Undo reselects a cut, closes the @ picker, takes back a whole uploaded image, and takes back only a mention added from the menu even after an edit the browser announced but never made; a word still in composition enables Send. In Chromium and WebKit, wide and at phone size, Enter starts a new line on a touch screen and only Send sends, while a physical keyboard sends on Enter and starts a new line on Shift+Enter.
- `browser/nav.test.ts`: hiding the nav is kept per layout and comes back from the chip, the top edge and the shortcut; below the 900px switch point the phone header opens the nav sheet and Waiting on you and a task opens full screen with Context, Chat and Activity, while at 900px the wide bar and inline tasks stay; on a touch screen a card's ⋯ opens its actions.
- `browser/pickers.test.ts`: `@` matches every typed word ignoring case, accents and spaces, offers other Titans, renders only the rows in reach and reaches the last by arrowing, and keeps its rows through unrelated changes; `/` matches commands only; the model step shows its list at once when reopened, and Reload changes only the rows that changed and keeps the list when it fails; `@` offers project files, a typed path shows its folder's contents filtered as the name is typed without asking the server again, and the rows shown stay while the next folder loads instead of the parent folder's whole contents.
- `browser/status.test.ts`: Independent first-send flows for Titan and a task without an attached worker show Starting… on the first animation frame after Send, Thinking at turn start, Working through tools and Idle at turn end. The worker pill and chat agree on each sampled frame. A refused first start shows its server error; later in-place turns follow live lifecycle facts. Refused turns show their error, later turns clear stale failures, outside delivery errors replace pending badges, and Oracle preserves status on tasks with a retention deadline.
