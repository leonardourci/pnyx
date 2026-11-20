# Development

[Back to Pnyx](../README.md)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the issue, review and merge process.

## Build and test

Use Node 22.13 or newer (22.18 for `pnpm deslop`) and the pnpm version pinned in `package.json`. The tests also need PostgreSQL 15 or newer installed (`brew install postgresql@17`, or `sudo apt-get install postgresql` on Ubuntu); a test run starts its own throwaway cluster on a random port and never uses a running one.

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

CSS uses the recommended Biome rules with Tailwind v4 parsing enabled in `biome.json`. The editor, `pnpm lint:css`, `pnpm run lint`, `pnpm deslop` and CI share this config. CSS formatting is unchanged. The specificity-order rule is disabled because it compares unrelated components; the important-style rule is disabled because layout overrides and reduced-motion accessibility use `!important`. Other CSS warnings fail verification.

Run `pnpm lint:fix` to apply formatting. Objects, destructuring patterns, type literals, arrays, parameter lists and call arguments with more than one item use one item per line. A single item may stay inline. `pnpm run lint` checks the same rules without fixing them.

`pnpm run build` compiles into its own `dist.next.<pid>` folder and renames it to `dist` only after the whole build passed, so a failed or interrupted build leaves the last working `dist`.

Imports across folders use the `package.json` aliases: `#<folder>/<file>.ts` resolves to `src/` and `#web-<folder>/<file>` to `web/src/`. Built code resolves `#…` to `dist/`, so anything that runs TypeScript from `src/` passes `--conditions=source`, or its `#` imports load the built files. Vitest (`vitest.config.ts`), `pnpm dev:server` and the Vite scripts pass it. A child the server starts with `execFile` and a login service installed from source take it from `SOURCE_CONDITIONS` in `src/app/source-conditions.ts`. The session-start hook adds it when its CLI is a `.ts` file.

See [AGENTS.md](../AGENTS.md) for the layout and design rules, and [follow-conventions](../.agents/skills/follow-conventions/SKILL.md#files-and-concerns) for when to split a file. `pnpm run lint` and `pnpm test` give deterministic verification. Each test file runs in its own process with a scratch home, its own copy of a migrated database and no inherited agent identity; see [Testing](testing.md) for the layout and focused test commands. `pnpm run web:dev` serves the Hydra through Vite. Check page changes in an isolated local preview and show them in the pull request's screenshots.

Owner actions in the app run in the server, which holds each Hydra in memory and is its only writer, so no command waits on another writer's lock. A validation or permission refusal returns its reason at once. The writer applies a command's events to its loaded state, retains changed properties for the lifecycle rules' before-state and records which cards they touched. It then commits the events, those cards' rows and the small rows that read across cards in one Postgres transaction, which updates the Hydra's `seq` only from the value it read. A command that throws or loses that race commits nothing, and the Hydra is read back from its rows. Rows reloaded from Postgres must match a cold replay of the events.

What the server keeps in memory per Hydra is its state, the ids of its events (so a repeated event is applied once) and a digest of each saved row (so a write finds the rows it changed); it keeps no event. Anything older is read from Postgres when asked, by card, type, time or seq, through filtered reads; history scans keep at most 200 events per page, and an item sent to a page, such as an update, is capped at 64 KB. Hook reports log only their id and byte count in Detailed mode; their content never enters diagnostic logs.

The writer and reducer are synchronous, so Postgres statements run on a worker thread's connection and the caller waits for the answer. A home's database is created and migrated with `src/store/schema.sql` on first use. The schema is applied only to a database without Pnyx's tables, so drop a database a pre-release build of the Postgres storage created (`dropdb <database>`) before using it again.

The page reads Pnyx's data through Zero's named queries in `src/store/zero-schema.ts`: the open Hydra's row (configuration, columns, page values and queue), the 1000 most recently changed live board cards with their questions, declarations, links and the replies that answer a question, a reference for each of the 1000 most recently changed cards other than automatic tasks (what chips, mentions, waits and answer leads read), the owner's latest message to Hydra, the Hydra list, the shared settings and the upgrade check. Every list a card relates holds its newest 100 rows, which the page puts back in order, so no query grows with a Hydra's history. Zero keeps its rows in the browser per installation, so a reload shows the last rows at once while it catches up. The page builds the Hydra it shows from those rows; an unchanged row keeps its card, so a write redraws only the cards it touched. Facts that read across cards (a working child session, the waited-for task's title, unmet prerequisites and each pull request's deciding merge question) come with each card from the server, so the page needs only the cards it shows.

Opening a card reads it whole through `card.detail`, by its id or key, so a card outside the board and the references opens too; Hydra's own card is always read that way. The page still sends `pnyx-axi page --card <id>` so the server sends those cards' live replies, actions, spend and usage, which stay socket pushes. Of Hydra's conversation the page reads only the owner's latest message, through `hydra.ownerMessage`; the chat itself arrives in thread pages. The page holds no events: Zero replicates only the tables and columns its queries read, and none of `events` or `card_updates`. A task's Updates tab reads its events from the server with `task updates <task> [--before <seq>] [--limit <n>]`, newest first, 50 at a time, each capped at 64 KB. It reads the next page when its list reaches the end, reads the newest page again when the Hydra's `seq` moves, and renders only the rows near the viewport.

Optimistic page edits confirm from their request's scoped receipt once the page reaches its durable sequence. A delayed page update keeps the preview visible; reconnect retries the same attempt. The page does not retain an event-ID history for confirmation.

The offline badge appears after the page detects a connection failure or a missed heartbeat and clears when its WebSocket opens again. Initial loading, switching Hydras and resynchronizing state do not imply that the page is offline. Actions still wait for the selected Hydra's subscription to be ready. The socket retries automatically with backoff capped at ten seconds and no attempt limit. Returning to a visible page, restoring it from the browser cache or coming back online replaces a stale connection immediately. Restarting or upgrading the server reloads the selected Hydra's state and conversation subscriptions automatically. A rejected handshake refreshes the page token for the same installation; an installation change or missing token asks for a page reload.

Hydra subscriptions have their own loading deadline, which runs until both the socket and Zero have shown the Hydra, and retry transient failures automatically, even while socket heartbeats still succeed. A query Zero cannot answer shows its reason and automatically rebuilds the failed views with backoff capped at ten seconds. When Zero's connection stops (after an error, a refused login or a close), the page refreshes its data cookie and opens a new client, restoring the open cards as well as the Hydra. Pending edits and the current view stay visible while reads recover. Structured `page.recovery` lines record stale, retry and reconciled transitions; `page.zero` lines record connection state changes. A permanent refusal, such as a missing Hydra or denied access, shows its reason and a retry for that Hydra. Ordinary command errors keep their own message and a Dismiss button.

Completed native replies and explicit chat updates remain visible when a later turn ends quietly. During an owner's running turn, its latest commentary stays visible as streaming text becomes a native transcript record. Finished turns fold commentary into progress notes. A running turn keeps its tool calls and thinking in progress below its latest message, never as chat rows. Native commentary does not become a background notification. Older archived records without completion metadata retain their previous conservative rendering.

Hydra's chat opens on its newest page, about twenty messages, and reads each older page by itself as the top of the conversation nears the screen, with no button, keeping the message the owner reads where it was. A conversation the transcript does not bound (no readable transcript, or one that holds all its messages) pages through Hydra's saved messages the same way: the first page holds the newest 20, its `older` cursor is `m<message id>` and the page's `messagesFrom` is the time of its oldest message, so the conversation shows nothing older until the next read.

Hydra thread subscriptions keep their loaded history on the server. Subscriptions that read a transcript file reuse the saved page and its conversation projection while only live text grows. Transcript file changes, relevant state or settings changes, session changes and explicit history requests rebuild that base. The first live text update after idle is sent immediately; sustained text updates coalesce within 80 ms. Status and latest-message refreshes keep their 200 ms cadence. The reveal clock caps an elapsed frame at 100 ms so a suspended frame resumes gradually. Re-reading a thread keeps its existing subscription. After a reconnect, the page sends its session and oldest loaded entry so the server restores that range before replacing the conversation. A changed session starts fresh; repeated history cursors fail explicitly. Each thread page carries reconciled conversation entries, turn timings and action folds. Continuation chunks carry a boolean, and injected instruction blocks are hidden before transport. The browser renders that projection and keeps only its unsent previews locally. The server also sends Hydra's held inputs, pending operations and queue state; the browser uses those facts to place its unsent previews.

A conversation page counts as delivered only when the socket accepts it. If the socket buffer is full, the server retains the newest page for that subscription and retries when it can send again; a newer page replaces the pending one. Closing a tab cancels its pending delivery. Replacing a subscription cancels its old page and responds to every pending read with an error, retrying those errors if the socket is still backed up. A resync refreshes its conversation as well as its latest activity, so the final text does not depend on another content change or a reload.

Working status and current actions recover when the socket drains, without waiting for another event; Hydra data and lists come back through Zero. Pending message and action maps merge sparse updates and retain explicit removals, and go out as one batch once the socket drains. Current native work takes precedence over the timestamp of the last call written to the transcript; timestamp filtering applies to transcript-only actions.

Live replies retain every transport part through handoff to the native transcript. Native history targets 60 parts per page, with at most 1,000 UTF-16 code units per part. If the target falls inside a message, the page includes that message's remaining parts, so it can exceed 60. Native reads remain bounded to a 10 MiB window, and retained-history restoration stops after 1,000 pages.

## Diagnostic logs

The server writes one JSON line per action to `logs/<UTC date>.jsonl` under `PNYX_HOME`, for debugging Pnyx itself. Logs are separate from Hydra data, never change Hydra state and are never shown in the page. Only the server writes the folder; another `pnyx-axi` process prints its warnings and errors on its own stderr. The installed service sends stdout and stderr to `service.log`, which holds `serve`'s start message, anything Node prints itself, such as a crash, and any warning or error the log folder could not take.

Server code logs through one function, `log({ operation, ...fields })` in `src/app/diagnostics.ts`, and the page through its own `log()` in `web/src/app/log.ts`, with the same line type and level rule, which sends its lines to the server in batches over the page's WebSocket. A call with neither `detailed` nor `level` writes an action's line when the action ends. `detailed: true` marks a line written only under Detailed; below that the call returns before building the line. `level: 'warn'` or `level: 'error'` marks a failure, and an error line requires the thrown value as `error`. The level is held in memory and updated when the setting changes, so a call never reads the settings file.

Each line has `v`, `at` (UTC), `source` (`server` or `web`), `operation` and the ids that apply: `hydraId`, `taskId`, `sessionId`, `correlationId`, `requestId`, `operationId` and `eventSeq`. A server line adds the process's resident memory (`rss`), except a detailed one, which the lines around it cover; every server line adds the process id (`pid`). A page line adds its `tab`, and the server places it at its age on the page's monotonic clock, so a line that waited for the socket keeps its time without trusting the page's wall clock. A line keeps only the fields the line type lists, each text cut to 200 characters. The line that ends an action has its duration in `ms`, from the monotonic clock, and `startedAt` inferred from its completion timestamp `at` and duration (wall-clock adjustments can affect the inferred start), and sizes where they matter: `bytes` written or sent, in UTF-8, and the socket's `backlog`. `name` narrows the operation, such as the command, tool and its subcommand (never an id the command takes, so `card <id>` is `card`), message or event type, or the file a warning is about; a command line from the owner's terminal is logged as `actor: cli` on the Hydra it runs on. Every line has an explicit `level` (`info`, `debug`, `warn` or `error`). Warnings and errors always have an `operationId`, which a failed retry shares. Errors retain a SHA-256 message fingerprint, a bounded stack of verified call sites, a machine error code and up to five causes and aggregate members. A page error whose message reaches the wire limit omits its stack because the header may be truncated. Arbitrary error text and thrown values are omitted because they can contain prompts, credentials or subprocess output. Fingerprints group repeated failures without retaining their input. While logging is On or Detailed, every 30 seconds the `process` line records the server's CPU, event-loop delay past its 20 ms sampling interval and use, heap, active resource count (`activeResources`, the number of resources keeping the event loop alive) and garbage-collection pauses; a `storage` line records the current Postgres database size (`databaseBytes`, including indexes) and retained diagnostic files (`logBytes`). The metadata query has a 100 ms wait limit. This is one metadata query and a scan of the bounded log folder per sample, with no recursive home scan. One `agent.memory` line lists every agent the server runs, for Hydras, workers and the helper, with its `hydraId`, `taskId`, `sessionId` and the resident memory of its whole process tree, from one `ps` listing, also measuring the zero-cache process tree (`zeroRss`); and each open page writes `page.memory`, read when the browser is idle, with its chat's size (`chatChars`, the length of the chat it holds, serialized), its `messages`, its DOM `elements` and, in Chromium only, its JS heap (`heapUsed`). Lines carry identifiers, never prompts, credentials or request bodies. Stack call sites and some warnings' `name` hold local paths, so sanitize logs before sharing them. HTTP work gets a generated `requestId`, inherited only while the request is open; later background work drops it. Message and batch correlation keeps its separate `correlationId`. HTTP logs retain a route family, never the URL or query string. Successful HTTP requests are Detailed-only. Event reads (`events.read`) are Detailed-only unless they take at least 100 ms; scans log one total with their page count; history-page timings (`history.read`) remain in On mode. PR reads retain task and Hydra ids with their duration; quota subprocess durations appear as `exec` with name `quota-axi`.

The Logs setting chooses Off (warnings and errors only), On (the default, one line per action) or Detailed, for debugging streaming: also a line per live chat update and socket message, each page update with the reveal frames drawn since the last and the slowest of them (`frames`, `worstFrameMs`), a `page.frame` line only for a reveal frame longer than one and a half display frames, and an `agent.memory` reading of the turn's agent at the start and end of each turn. Pnyx keeps 7 days and 500 MB by default, deleting older days first, at start, when the days or size setting changes and every minute. Lowering the cap stops further appends immediately; an already oversized current-day file stays until age retention removes it. Today's file is never deleted for size. Its append allowance is the folder cap minus every other retained day, including buffered writes across UTC rollover. The first refused info line emits one `logs.full` warning per day. Warnings and errors can use twice the remaining allowance, then appends stop; each cleanup writes one `logs.dropped` warning to stderr with the refused-line count and a timeline id. Successful `git rev-parse`, `git symbolic-ref`, `git remote` and `card.observed` lines are Detailed-only. Repeated identical warnings/errors keep an immediate first occurrence and a suppressed `repeatCount` after a 60-second interval or shutdown. Zero-cache output retains only a SHA-256 fingerprint and its worker tag in every mode. The writer checks the byte budget before each append, including buffered writes, so an error storm cannot exceed the reserved error budget. `pnyx-axi logs clean` deletes every file now. `pnyx-axi debug performance` reads the lines back as counts and durations per action, server, agent and zero-cache memory, active resources, database/log sizes over time and the slowest actions, and `jq -R 'fromjson? | select(.hydraId == "lab")' "$PNYX_HOME"/logs/*.jsonl` selects one Hydra's lines, skipping a line still being written.

## Run a development server

```sh
pnpm dev
```

`pnpm dev` runs a Pnyx server with its own data folder (`~/.pnyx-dev`, or `PNYX_DEV_HOME`), so it never competes with your installed server for your Hydras, opening its `dev` Hydra under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web app in place as you edit `web/`. Open the URL Vite prints; it forwards the Hydra's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).

### Owner-facing trials

For a trial you hand to the owner, use an isolated data home and run under portless when it is installed (`command -v portless`):

```sh
PNYX_HOME=/path/to/trial portless trial.pnyx pnyx-axi serve
```

Choose a unique `<name>.pnyx` for each trial and share the stable URL portless prints. Leave `--port` unset: Pnyx reads the `PORT` supplied by portless. Use the same `PNYX_HOME` for every trial command, including `stop`. Without portless, use `PNYX_HOME=/path/to/trial pnyx-axi serve --port 0` and share the printed URL. Automated tests continue using random ports; do not wrap them in portless.

## Verification

Run `pnpm deslop` on clean, committed work. Pushed runs need an open pull request: `Tests` runs only on pull requests, and deslop waits for its checks. The review reads the PR description as the intent, including its folded Intentional slop section, and lists the code comments the diff adds (every comment in JavaScript and TypeScript; elsewhere only comments that start a line, not trailing ones); see [deslop's README](https://github.com/leonardourci/deslop#readme) for tool usage and proof details.

`deslop.config.json` selects the first matching kind for each path and combines their requirements. The local code commands below are `pnpm lint:fix`, `pnpm typecheck`, `pnpm lint:css` and `pnpm build`. The full test suite runs in CI. `checkFixAttempts` is 0: check failures return to the caller for a fix and a new run. `agentTimeoutMinutes` is 45: a reviewer call that runs longer ends the run red.

| Kind | Local commands | CI check | Review instructions |
|---|---|---|---|
| Workflow | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop, write-ci-workflow |
| Fixture | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop |
| Shipped skill text | None | Lint, build and tests | Project, conventions, kill-ai-slop |
| Docs | None | Test scope | Project, conventions, kill-ai-slop |
| Tests | Code commands | Lint, build and tests | Project, conventions, audit-tests |
| UI | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop, write-front-end |
| Back-end | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop |

Project means `AGENTS.md`; conventions means `follow-conventions`. `review-code`, `audit-tests` and `kill-ai-slop` are deslop's shipped skills; the instruction map adds Pnyx's `follow-conventions`, `write-front-end` and `write-ci-workflow`.

`Tests` runs on `pull_request` with read-only permissions, no secrets and no path filters. `Test scope` installs the selector from package.json without lifecycle hooks and reads the merge diff, including both paths of renames. It runs tests when the selection names `Lint, build and tests`. Docs-only changes skip that job, satisfying branch protection. The docs kind names `Test scope` because deslop requires a successful CI check to publish proof. A failed scope job still runs tests behind the approved `ci` environment. Description edits start no run; new pushes cancel older runs.

The PR controls the workflow, selector spec and config, so changes to those files need owner review. The read-only token, absence of secrets and approval-gated tests limit what untrusted code can do.

For CI approval:

1. Push committed work to the PR branch and run `pnpm deslop`.
2. Wait for the local commands to pass. Record the final `git rev-parse HEAD`, confirm it matches the PR head, and collect the local results from the deslop logs.
3. Ask Hydra for approval with that SHA, the local results and the waiting CI run URL.
4. After CI passes, confirm deslop wrote proof for the same commit. Any new commit needs its own checks and approval.

## Background reads

Pull request reads run once per minute while the worker works, checks are pending or a merge attempt remains unresolved, and once per 15 minutes for idle, unchanged links. A failed read (offline, expired login, rate limit) keeps that schedule; after three reads that find no pull request, a link waits for a task or link change and the server logs `follow.suspend` once. A link added by a worker or the owner, a task declaring or leaving `working`, a new task copy, Git ref changes to a working copy's own branch (local or on a remote), and `task refresh-links <task>` make a read due immediately; other task events do not. Opening a task, including its Ready for review panel, runs that command again after each reconnect, one request per task at a time; review decisions shown in chat do not. `task refresh-links` also discards a status read in flight, so the link stays due when that read finishes; the other triggers keep that read. Ref watches close when work ends; a failed watch setup or runtime error is logged once and tried again after a minute. Usage limits share one five-minute server cache per login across tabs and Hydras; an explicit refresh bypasses it. Failed quota reads are retried on the next request, and a changed reading updates every visible session using that login. Background transcript polling and folder watches follow working sessions and sessions with unknown activity. Known finished or ended sessions release those resources; the next turn restores them.

The scheduler drains the spool at startup, in the tick a hook socket line starts and after the spool folder's watcher fires; unrelated ticks do not list it. A failed drain retains the dirty flag and retries after one second. `debug cpu-profile --out <file>` samples the server's main thread without an inspector listener. Profile with an isolated daemon and private fixture data during development.

## Review

Hosted agent processes lead their own process groups. Completing or archiving a task, or releasing its copy, stops its recorded groups with SIGTERM, escalates to SIGKILL if necessary and waits for exit. A group that still does not stop fails with `AGENT_STOP_FAILED` naming its processes; a closed task's cleanup tries once, and the next permanent release tries again. A worker that declares its own task done is stopped when that turn ends, and so is a worker a later reply resumes. Idle closure and server restart close the agent leader while leaving background tools running, so detached verification can finish. Group ownership remains recorded after the leader exits and across restart until permanent cleanup. Copy release keeps its folder if its host is unavailable or its worker is still starting; retry once the host is ready. Tools that start a separate process group are outside this cleanup.

Copy settlement holds the task lease until its folder decision is saved. A server start drops settlement leases a stopped server left behind, since only the server settles copies. Ordinary replies stay in the existing inbox until then; new starts and native controls can be retried after cleanup. A released pool slot cannot resume the old session, including an older session recorded through a folder alias. New hosted starts record canonical folders. Copy removal also refuses while a launch or notification is pending; notification ownership lasts through its saved receipt and preserves delivery while the routine helper holds a task.

Older child records without the background-preservation marker retain the earlier startup group cleanup behavior. New records preserve background tools across restart.

## Web UI

Motion timing lives in `web/src/shared/motion.ts` and the matching `@theme` tokens in `web/src/index.css`; change `MOTION_MODE` to `off` for instant motion, and keep token values together when changing the timings.

Interface icons share `web/src/shared/icons.tsx`: `Icon`, `hasIcon`, `ICON_SIZE` and `ICON_STROKE`. Use the size roles (`badge`, `inline`, `control`, `toolbar`, `heading`, `brand`) instead of pixel literals. Line glyphs use Tabler at a constant 1.5 screen-pixel stroke; identity and provider marks retain their licensed filled artwork. The registry and identity assets live in `web/src/shared/ui/icons/`. All marks resist flex shrinking so adjacent text cannot change their size.

Card geometry lives in `web/src/shared/card-sizing.ts`, with persisted view limits in `src/preferences/workspace.ts`; shared controls live in `web/src/shared/ui/` (`IconButton`, `DisclosureChevron`, `Resize`, `HoverActions`, `Dialog`). Change those primitives for repeated patterns instead of styling a second version inside a feature.

### UI performance measurements

The page's metrics use the existing fire-and-forget log path: `web/src/app/ui-metrics.ts` aggregates measurements, `web/src/app/log.ts` batches them over the existing socket, and the server appends `source: "web"` JSONL lines to `$PNYX_HOME/logs/YYYY-MM-DD.jsonl`. Metrics never enter Hydra events, Zero rows or a server-side metrics cache. `pnyx-axi logs` shows the folder; `pnyx-axi debug performance` groups logged durations by the metric’s static surface/action name; its percentiles describe window maxima, not raw interactions. Filter by `operation`, `surface`, `action`, `hydraId` and `tab` when reading individual lines.

The single runtime switch is the existing Logs setting. `pnyx-axi settings set --json '{"logs":"off"}'` disconnects the performance observers, input capture listeners and metrics timer, cancels drag sampling, and drops pending metric aggregates. Ordinary warning/error logging keeps its existing behavior. Logs On resumes collection. No owner text, field values, task titles, DOM paths or keystrokes enter these metrics; action names are static tokens.

The normal build uses the ordinary React renderer. For React measurements, run `VITE_PNYX_PROFILE=1 pnpm run build` (or the same flag with `pnpm run web:dev`). That one build flag aliases `react-dom/client` to `react-dom/profiling`, emits source maps for Chrome stack attribution and enables `ProfileSurface` in `web/src/app/profile-surface.tsx`. Rebuild without the flag after diagnosis. Normal builds bypass the profiler boundaries and collect only browser measurements.

Components and flows use the same API:

```tsx
<ProfileSurface name="chat" hydraId={hydraId}>
  <Chat />
</ProfileSurface>
```

`ProfileSurface` reports React's `actualDuration` through `recordUIRender({ surface, hydraId, ms })`. This is render work associated with a commit, not the duration of DOM mutations. `page.react-commit` counts every observed commit, samples the first and every tenth duration per aggregate, and reports `samples`, `totalMs` and worst `ms`. Nested surfaces overlap; do not sum their render durations. The named boundaries cover workspace, chat, Settings, Oracle and sortable rendering.

```ts
const finish = timeUIFlow({ surface: 'workspace', action: 'settings.open' })
try {
  await operation()
} finally {
  finish()
}
```

`timeUIFlow` records `page.flow` once when `finish()` runs; work spanning Logs Off is discarded. Settings navigation uses it. `trackUIDrag({ action: 'task' })` returns the same kind of cleanup function and is connected to the existing sortable lifetime. Its `page.drag-frames` line reports the longest gesture in `durationMs` (separate from frame intervals), `frameCount` observed intervals, `frames` estimated missed intervals and `worstFrameMs`. The estimate starts with a 60 Hz budget and learns the shortest observed interval down to 240 Hz. Hidden-tab gaps are excluded. These are requestAnimationFrame estimates; use Chrome traces to inspect actual rendering and presentation.

`page.long-task` summarizes supported Long Tasks entries; existing Long Animation Frame diagnostics remain as bounded `page.slow-frame` summaries. `page.slow-interaction` keeps the worst Event Timing entry per interaction ID above 104 ms, with `inputDelayMs`, `processingMs` and `presentationMs`. It is an INP-style diagnostic sample, not a page-level INP score. Static `data-ui-surface` and `data-ui-action` attributes name controls; otherwise the collector uses known patterns or the control's role/tag. Input capture retains those names before React changes the target. Browser support is feature-detected; unsupported APIs produce no samples. Existing idle `page.memory` samples include `heapUsed` where the browser exposes it, plus retained chat and DOM sizes.

Aggregates flush every ten seconds and on page hide, with at most 32 groups, 128 entries per observer callback and 128 retained interaction IDs/input contexts. The existing logger caps disconnected queues at 1,000 lines and batches socket payloads within the wire limit. `count` is the number of aggregated observations, `samples` the measured subset, `ms` the worst sampled duration and `totalMs` the sampled total. `page.metrics-overhead` instead records measured collector/heap-sampling/serialization work in `ms`, elapsed sampling-window time in `totalMs`, callback count and discarded entries in `samples`. It excludes the browser's internal observer/profiler cost; compare normal/profiling and Logs On/Off Chrome traces for that overhead.
