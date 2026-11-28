# Development

[Back to Othrys](../README.md)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the issue, review and merge process.

## Build and test

Use Node 22.13 or newer (22.18 for `pnpm deslop`) and the pnpm version pinned in `package.json`. The browser checks in `tests/browser/` also need Google Chrome and Playwright's Chromium and WebKit (`pnpm exec playwright-core install chromium webkit`), which they open headless with a profile of their own. CI installs the Playwright browsers before the tests.

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

CSS uses the recommended Biome rules with Tailwind v4 parsing enabled in `biome.json`. The editor, `pnpm lint:css`, `pnpm run lint`, `pnpm deslop` and CI share this config. CSS formatting is unchanged. The specificity-order rule is disabled because it compares unrelated components; the important-style rule is disabled because layout overrides and reduced-motion accessibility use `!important`. Other CSS warnings fail verification.

The web UI uses Tailwind v4 tokens in `web/src/index.css` and the shared controls in `web/src/shared/ui/`. Extend an existing control before adding a new one. Repeated screen patterns belong in shared components; feature-specific layout stays with its feature. ESLint sorts classes with `eslint-plugin-better-tailwindcss`, rejects arbitrary values and properties, and rejects inline styles. `pnpm lint:fix` sorts classes, while `pnpm verify` runs lint, the build and all tests. Arbitrary selector variants remain available because they express states and descendants rather than new design values.

Measured geometry and owner-selected font sizes use the closed runtime-style helpers. `runtimeStyle` supplies React style props; `applyRuntimeStyle` applies the same allowed dimensions, transforms and named CSS variables to an existing DOM node. Use `style={runtimeStyle({ width: measuredWidth })}` or `applyRuntimeStyle({ element, values: { left: measuredLeft } })` for measured geometry and theme classes for fixed values. ESLint rejects fixed helper values, including signed numbers and expression-free templates, and direct DOM style access outside the helper module. Class-list calls follow the same arbitrary-value and ordering rules as JSX.

Run `pnpm lint:fix` to apply formatting. Objects, destructuring patterns, type literals, arrays, parameter lists and call arguments with more than one item use one item per line. A single item may stay inline. `pnpm run lint` checks the same rules without fixing them.

`pnpm run build` compiles into its own `dist.next.<pid>` folder and renames it to `dist` only after the whole build passed, so a failed or interrupted build leaves the last working `dist`.

Imports across folders use the `package.json` aliases: `#<folder>/<file>.ts` resolves to `src/` and `#web-<folder>/<file>` to `web/src/`. Built code resolves `#…` to `dist/`, so anything that runs TypeScript from `src/` passes `--conditions=source`, or its `#` imports load the built files. Vitest (`vitest.config.ts`), `pnpm dev:server` and the Vite scripts pass it. A child the server starts with `execFile` and a login service installed from source take it from `SOURCE_CONDITIONS` in `src/app/source-conditions.ts`. The session-start hook adds it when its CLI is a `.ts` file.

See [AGENTS.md](../AGENTS.md) for the layout and design rules, and [follow-conventions](../.agents/skills/follow-conventions/SKILL.md#files-and-concerns) for when to split a file. `pnpm run lint` and `pnpm test` give deterministic verification. Each test file runs in its own process with a scratch home, native log files and no inherited agent identity; see [Testing](testing.md) for the layout and focused test commands. `pnpm run web:dev` serves the Titan through Vite. Check page changes in an isolated local preview and show them in the pull request's screenshots.

Owner actions run in the daemon, which is the only writer. One ordered queue stages each command against memory and appends its meaningful facts to the Titan and task logs. It syncs the touched files before returning a receipt and publishes the resulting state afterward. State reducers perform no I/O, clock reads or random choices.

Observation-only source advances (`generation`, `cursor` and observed time) live in daemon memory. Their stale-report checks compare the currently reconstructed source refs; restart restores what each transcript wrote after its session's last saved turn record. Push-only ordering watermarks expire at restart. Worker report identity and byte-offset facts remain durable in each task log. Integrations that need ordering across restarts keep their evidence in a native source Othrys can reread.

Dispatch reads use the committed journal without rewriting its human-readable config mirrors. The daemon repairs those mirrors after claiming the home and when preparing a configuration change, so local setup diagnostics cannot overwrite a newer daemon commit.

Native IDs preserve idempotency across restart and folder moves. Each log assigns its own `n`. Sequence references in saved projections use native IDs; process-local positions are rebuilt when the daemon opens the home. History is read from the native logs and cached on demand. An item sent to a page, such as an update, is capped at 64 KB. Hook reports log only their id and byte count in Detailed mode; their content never enters diagnostic logs.

Snapshots cache folded decisions, accepted IDs and file offsets. The daemon snapshots after five minutes with changes and on clean stop. A bad cache falls back to log replay. Derived observations are rebuilt from the harness’s native files, with transcript cursors reset on open. A write failure reports its error; complete lines already written are reconciled before a retry can succeed. See [native file persistence](file-store.md) for recovery details.

The page reads Titan state, the Titan list, shared settings and upgrade status through the same authenticated WebSocket as live agent activity, conversations and command receipts. The server sends a home snapshot followed by ordered changes. A cursor contains the daemon epoch and sequence; reconnect replays up to 50,000 retained changes within 4 MiB, or sends a fresh snapshot when the cursor is unavailable or the replay exceeds its wire budget. Applying a change preserves unchanged card objects. Private steering and external source claims stay on the server.

The page sends `othrys page --card <id>` for the cards' live replies, actions, spend and usage. Conversations arrive in thread pages; the home feed carries only the owner's latest message to Titan. A task's Updates tab reads its events from the server with `task updates <task> [--before <seq>] [--limit <n>]`, newest first, 50 at a time, each capped at 64 KB. It reads the next page when its list reaches the end and the newest page when the Titan's `seq` changes.

Optimistic page edits confirm from their request's scoped receipt once the page reaches its durable sequence. A delayed page update keeps the preview visible; reconnect retries the same attempt. The page does not retain an event-ID history for confirmation.

The offline badge appears after the page detects a connection failure or a missed heartbeat and clears when its WebSocket opens again. Initial loading, switching Titans and resynchronizing state do not imply that the page is offline. Actions still wait for the selected Titan's subscription to be ready. The socket retries automatically with backoff capped at ten seconds and no attempt limit. Returning to a visible page, restoring it from the browser cache or coming back online replaces a stale connection immediately. Restarting or upgrading the server reloads the selected Titan's state and conversation subscriptions automatically. A rejected handshake refreshes the page token for the same installation; an installation change or missing token asks for a page reload.

Titan subscriptions have their own loading deadline, which runs until both the home feed and the Titan subscription are ready. Pending edits and the current view stay visible while reads recover. Structured `page.recovery` lines record stale, retry and reconciled transitions. A permanent refusal, such as a missing Titan or denied access, shows its reason and a retry for that Titan. Ordinary command errors keep their own message and a Dismiss button.

Completed native replies and explicit chat updates remain visible when a later turn ends quietly. During an owner's running turn, its latest commentary stays visible as streaming text becomes a native transcript record. Finished turns fold commentary into progress notes. A running turn keeps its tool calls and thinking in progress below its latest message, never as chat rows. Native commentary does not become a background notification. Older archived records without completion metadata retain their previous conservative rendering.

Titan's chat, task pills and task chats share one live status label: Starting… from the client's pending send, Thinking from turn start, Working while tools run and Idle when the turn ends. A failed start replaces the pending label with its error. Focus mode hides tool names while preserving these labels. Owner questions and worker declarations retain their status priority once the turn is observed; the CLI continues to report active turns as running.

Reply receipts retain their event sequence and turn start so a failed attempt cannot mask a later turn. Outside delivery failures use their own receipt's error.

Titan's chat opens on its newest page, about twenty messages, and reads each older page by itself as the top of the conversation nears the screen, with no button, keeping the message the owner reads where it was. A conversation the transcript does not bound (no readable transcript, or one that holds all its messages) pages through Titan's saved messages the same way: the first page holds the newest 20, its `older` cursor is `m<message id>` and the page's `messagesFrom` is the time of its oldest message, so the conversation shows nothing older until the next read.

Thread subscriptions, Titan's and each task's, keep their loaded history on the server. Subscriptions that read a transcript file reuse the saved page and its conversation projection while only live text grows. Transcript file changes, relevant state or settings changes, session changes and explicit history requests rebuild that base. The first live text update after idle is sent immediately; sustained text updates coalesce within 80 ms. Status and latest-message refreshes keep their 200 ms cadence. The reveal clock caps an elapsed frame at 100 ms so a suspended frame resumes gradually. Re-reading a thread keeps its existing subscription. After a reconnect, the page sends its session and oldest loaded entry so the server restores that range before replacing the conversation. A changed session starts fresh; repeated history cursors fail explicitly. Each thread page carries a daemon epoch, a subscription stream and an ordered version, plus reconciled conversation entries, turn timings and action folds. A delta with a missing base requests a complete refresh; a new daemon epoch restores the loaded range through the existing retained-history read. Continuation chunks carry a boolean, and injected instruction blocks are hidden before transport. The browser renders that projection and keeps only its unsent previews locally. The server also sends Titan's held inputs, pending operations and queue state; the browser uses those facts to place its unsent previews.

A conversation page counts as accepted when the socket outbox owns it. The outbox retains ordered thread frames, receipts and errors while the socket drains. Latest activity coalesces within each Titan subscription without crossing a home-state change. Full activity refreshes retain one source per Titan and serialize cards as the socket drains, so a workspace larger than the live queue budget can complete its handshake and interest refreshes. If the live queue exceeds its byte limit, the server disconnects the slow client so it can resume from its home cursor and restored thread range. Replaced subscriptions reject outstanding reads, and closed clients cannot accept later results. A resync refreshes the conversation and current activity together.

Working status and current actions recover when the socket drains, without waiting for another event; Titan data and lists resume through the home feed. Pending message and action maps merge sparse updates and retain explicit removals, and go out as one batch once the socket drains. Current native work takes precedence over the timestamp of the last call written to the transcript; timestamp filtering applies to transcript-only actions.

Live and saved reply rows share the provider's native message and raw block identity, scoped by session; filtering tools or thinking does not renumber text blocks, and same-word replies with different IDs remain separate. Byte positions order records and page history. Live replies retain every transport part through handoff to the native transcript. Native history targets 60 parts per page, with at most 1,000 UTF-16 code units per part. If the target falls inside a message, the page includes that message's remaining parts, so it can exceed 60. Native reads remain bounded to a 10 MiB window, and retained-history restoration stops after 1,000 pages.

## Diagnostic logs

The server writes one JSON line per action to `logs/<UTC date>.jsonl` under `OTHRYS_HOME`, for debugging Othrys itself. Logs are separate from Titan data, never change Titan state and are never shown in the page. Only the server writes the folder; another `othrys` process prints its warnings and errors on its own stderr. The installed service sends stdout and stderr to `service.log`, which holds `serve`'s start message, anything Node prints itself, such as a crash, and any warning or error the log folder could not take.

Server code logs through one function, `log({ operation, ...fields })` in `src/app/diagnostics.ts`, and the page through its own `log()` in `web/src/app/log.ts`, with the same line type and level rule, which sends its lines to the server in batches over the page's WebSocket. A call with neither `detailed` nor `level` writes an action's line when the action ends. `detailed: true` marks a line written only under Detailed; below that the call returns before building the line. `level: 'warn'` or `level: 'error'` marks a failure, and an error line requires the thrown value as `error`. The level is held in memory and updated when the setting changes, so a call never reads the settings file.

Each line has `v`, `at` (UTC), `source` (`server` or `web`), `operation` and the ids that apply: `titanId`, `taskId`, `sessionId`, `correlationId`, `requestId`, `operationId` and `eventSeq`. A server line adds the process's resident memory (`rss`), except a detailed one, which the lines around it cover; every server line adds the process id (`pid`). A page line adds its `tab`, and the server places it at its age on the page's monotonic clock, so a line that waited for the socket keeps its time without trusting the page's wall clock. A line keeps only the fields the line type lists, each text cut to 200 characters. The line that ends an action has its duration in `ms`, from the monotonic clock, and `startedAt` inferred from its completion timestamp `at` and duration (wall-clock adjustments can affect the inferred start), and sizes where they matter: `bytes` written or sent, in UTF-8, and the socket's `backlog`. `name` narrows the operation, such as the command, tool and its subcommand (never an id the command takes, so `card <id>` is `card`), message or event type, or the file a warning is about; a command line from the owner's terminal is logged as `actor: cli` on the Titan it runs on. Every line has an explicit `level` (`info`, `debug`, `warn` or `error`). Warnings and errors always have an `operationId`, which a failed retry shares. Errors retain a SHA-256 message fingerprint, a bounded stack of verified call sites, a machine error code and up to five causes and aggregate members. A page error whose message reaches the wire limit omits its stack because the header may be truncated. Arbitrary error text and thrown values are omitted because they can contain prompts, credentials or subprocess output. Fingerprints group repeated failures without retaining their input. While logging is On or Detailed, every 30 seconds the `process` line records the server's CPU, event-loop delay past its 20 ms sampling interval and use, heap, active resource count (`activeResources`, the number of resources keeping the event loop alive) and garbage-collection pauses; a `storage` line records native log bytes from in-memory file positions (`stateBytes`) and retained diagnostic files (`logBytes`), without a recursive home scan. One `agent.memory` line lists every agent the server runs, for Titans, workers and the helper, with its `titanId`, `taskId`, `sessionId` and the resident memory of its whole process tree, from one `ps` listing; and each open page writes `page.memory`, read when the browser is idle, with its chat's size (`chatChars`, the length of the chat it holds, serialized), its `messages`, its DOM `elements` and, in Chromium only, its JS heap (`heapUsed`). Lines carry identifiers, never prompts, credentials or request bodies. Stack call sites and some warnings' `name` hold local paths, so sanitize logs before sharing them. HTTP work gets a generated `requestId`, inherited only while the request is open; later background work drops it. Message and batch correlation keeps its separate `correlationId`. HTTP logs retain a route family, never the URL or query string. Successful HTTP requests are Detailed-only. Event reads (`events.read`) are Detailed-only unless they take at least 100 ms; scans log one total with their page count; history-page timings (`history.read`) remain in On mode. PR reads retain task and Titan ids with their duration; quota subprocess durations appear as `exec` with name `quota-axi`.

The Logs setting chooses Off (warnings and errors only), On (the default, one line per action) or Detailed, for debugging streaming: also a line per live chat update and socket message, each page update with the reveal frames drawn since the last and the slowest of them (`frames`, `worstFrameMs`), a `page.frame` line only for a reveal frame longer than one and a half display frames, and an `agent.memory` reading of the turn's agent at the start and end of each turn. Othrys keeps 7 days and 500 MB by default, deleting older days first, at start, when the days or size setting changes and every minute. Lowering the cap stops further appends immediately; an already oversized current-day file stays until age retention removes it. Today's file is never deleted for size. Its append allowance is the folder cap minus every other retained day, including buffered writes across UTC rollover. The first refused info line emits one `logs.full` warning per day. Warnings and errors can use twice the remaining allowance, then appends stop; each cleanup writes one `logs.dropped` warning to stderr with the refused-line count and a timeline id. Successful `git rev-parse`, `git symbolic-ref`, `git remote` and `card.observed` lines are Detailed-only. Repeated identical warnings/errors keep an immediate first occurrence and a suppressed `repeatCount` after a 60-second interval or shutdown. The writer checks the byte budget before each append, including buffered writes, so an error storm cannot exceed the reserved error budget. Use the log files directly for cleanup. `othrys debug performance` reads the lines back as counts and durations per action, server and agent memory, active resources, database/log sizes over time and the slowest actions, and `jq -R 'fromjson? | select(.titanId == "lab")' "$OTHRYS_HOME"/logs/*.jsonl` selects one Titan's lines, skipping a line still being written.

## Run a development server

```sh
pnpm dev
```

`pnpm dev` runs an Othrys server with its own data folder (`~/.othrys-dev`, or `OTHRYS_DEV_HOME`), so it never competes with your installed server for your Titans, opening its `dev` Titan under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web app in place as you edit `web/`. Open the URL Vite prints; it forwards the Titan's WebSocket to the dev server on port 4319 (set `OTHRYS_DEV_PORT` to change it).

### Owner-facing trials

For a trial you hand to the owner, use an isolated data home and run under portless when it is installed (`command -v portless`):

```sh
OTHRYS_HOME=/path/to/trial portless trial.othrys othrys serve
```

Choose a unique `<name>.othrys` for each trial and share the stable URL portless prints. Leave `--port` unset: Othrys reads the `PORT` supplied by portless. Use the same `OTHRYS_HOME` for every trial command, including setup previews. Without portless, use `OTHRYS_HOME=/path/to/trial othrys serve --port 0` and share the printed URL. Automated tests continue using random ports; do not wrap them in portless.

## Verification

The [native file store](file-store.md) is the application’s persistence layer. Its recovery, queued-write and application restart tests use scratch homes.

Run `pnpm deslop` on clean, committed work. Pushed runs need an open pull request: `Tests` runs only on pull requests, and deslop waits for its checks. The review reads the PR description as the intent, including its folded Intentional slop section, and lists the code comments the diff adds (every comment in JavaScript and TypeScript; elsewhere only comments that start a line, not trailing ones); see [deslop's README](https://github.com/leonardourci/deslop#readme) for tool usage and proof details.

`deslop.config.json` selects the first matching kind for each path and combines their requirements. The local code commands below are `pnpm lint:fix`, `pnpm typecheck`, `pnpm lint:css` and `pnpm build`. The full test suite runs in CI. `checkFixAttempts` is 1: deslop gets one attempt to repair a failing check, such as its own edit that broke the build, before the failure returns to the caller. `agentTimeoutMinutes` is 45 here: a reviewer call that runs longer fails the run, unless `--agent-timeout` or the machine's `~/.deslop/settings.json` overrides it.

| Kind | Local commands | CI check | Review instructions |
|---|---|---|---|
| Workflow | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop, write-ci-workflow |
| Fixture | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop |
| Shipped skill text | None | Lint, build and tests | Project, conventions, kill-ai-slop |
| Docs | None | Test scope | Project, conventions, kill-ai-slop |
| Tests | Code commands | Lint, build and tests | Project, conventions, audit-tests |
| UI | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop, write-front-end |
| Back-end | Code commands | Lint, build and tests | Project, conventions, review-code, audit-tests, kill-ai-slop |

Project means `AGENTS.md`; conventions means `follow-conventions`. `review-code`, `audit-tests` and `kill-ai-slop` are deslop's shipped skills; the instruction map adds Othrys's `follow-conventions`, `write-front-end` and `write-ci-workflow`.

`Tests` runs on `pull_request` with read-only permissions, no secrets and no path filters. `Test scope` installs the selector from package.json without lifecycle hooks and reads the merge diff, including both paths of renames. It runs tests when the selection names `Lint, build and tests`. Docs-only changes skip that job, satisfying branch protection. The docs kind names `Test scope` because deslop requires a successful CI check to publish proof. A failed scope job still runs tests behind the approved `ci` environment. Description edits start no run; new pushes cancel older runs.

The full CI job runs `pnpm knip` after the build and before tests. Knip loads the Vite config, which resolves the server protocol import to the built file under the default Node conditions. The command uses `tsconfig.build.json` to map compiled imports back to source. Unused files, exports and dependencies fail the job, including exports used only within their own entry file. `knip.jsonc` lists workers and test processes launched at runtime.

The PR controls the workflow, selector spec and config, so changes to those files need owner review. The read-only token, absence of secrets and approval-gated tests limit what untrusted code can do.

For CI approval:

1. Push committed work to the PR branch and run `pnpm deslop`.
2. Wait for the local commands to pass. Record the final `git rev-parse HEAD`, confirm it matches the PR head, and collect the local results from the deslop logs.
3. Ask Titan for approval with that SHA, the local results and the waiting CI run URL.
4. After CI passes, confirm deslop wrote proof for the same commit. Any new commit needs its own checks and approval.

## Releases

Othrys uses SemVer below 1.0: `0.MINOR.PATCH`. A patch fixes or changes something without owner action, and the previous release can still read the data it leaves. A minor release adds features or needs the owner to act, or can't be undone by going back a release: a data format older builds can't read, a migration such as `pnpm migrate-session-turns`, another `othrys setup` run, or a Node or pnpm bump. `othrys --version` prints the `package.json` version and the installed commit.

`main` is the development line, and the newest `vX.Y.Z` tag is the stable release. A release starts only when the owner asks for one. Titan opens a pull request that only bumps `version` in `package.json`, so CI checks exactly the tree that ships, and the owner merges it with a merge commit. Titan then tags that merge commit and publishes it with `gh release create vX.Y.Z --generate-notes --verify-tag`, which lists the pull request titles merged since the previous tag. A release that needs owner action starts its notes with an Upgrade notes section saying what to run and whether the server must be stopped first. There are no release branches and no changelog file; the GitHub releases are the changelog.

The shared `upgradeChannel` setting decides what `/upgrade` and its upgrade-available hint follow: `stable`, the default, moves to the newest release tag on origin, and `development` follows origin `main`. Both only fast-forward, so a folder already past the newest release stays where it is until a later release includes it, and on `stable` an origin without a release tag makes `/upgrade` fail with that reason. Switch it in Settings › About › Upgrade channel; the hint clears and checks the new channel at once.

## Background reads

Pull request reads run once per minute while the worker works, checks are pending or a merge attempt remains unresolved, and once per 15 minutes for idle, unchanged links. A failed read (offline, expired login, rate limit) keeps that schedule; after three reads that find no pull request, a link waits for a task or link change and the server logs `follow.suspend` once. A link added by a worker or the owner, a task’s observed activity entering or leaving `working`, a new task copy, Git ref changes to a working copy's own branch (local or on a remote), and `task refresh-links <task>` make a read due immediately; other task events do not. Opening a task, including its Ready for review panel, runs that command again after each reconnect, one request per task at a time; review decisions shown in chat do not. `task refresh-links` also discards a status read in flight, so the link stays due when that read finishes; the other triggers keep that read. Ref watches close when work ends; a failed watch setup or runtime error is logged once and tried again after a minute. Usage limits share one five-minute server cache per login across tabs and Titans; an explicit refresh bypasses it. Failed quota reads are retried on the next request, and a changed reading updates every visible session using that login. Background transcript polling and folder watches follow working sessions and sessions with unknown activity. Known finished or ended sessions release those resources; the next turn restores them.

Branch discovery runs on worker launch, task-copy changes, worker-log entries, relevant ref changes and explicit refreshes. Its periodic checks use a separate one-minute cadence, backing off to fifteen minutes for idle tasks.

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

The page's metrics use the existing fire-and-forget log path: `web/src/app/ui-metrics.ts` aggregates measurements, `web/src/app/log.ts` batches them over the existing socket, and the server appends `source: "web"` JSONL lines to `$OTHRYS_HOME/logs/YYYY-MM-DD.jsonl`. Metrics never enter Titan events or a server-side metrics cache. `othrys logs` shows the folder; `othrys debug performance` groups logged durations by the metric’s static surface/action name; its percentiles describe window maxima, not raw interactions. Filter by `operation`, `surface`, `action`, `titanId` and `tab` when reading individual lines.

The single runtime switch is the existing Logs setting. Turning Logs Off in Settings disconnects the performance observers, input capture listeners and metrics timer, cancels drag sampling, and drops pending metric aggregates. Ordinary warning/error logging keeps its existing behavior. Logs On resumes collection. No owner text, field values, task titles, DOM paths or keystrokes enter these metrics; action names are static tokens.

The normal build uses the ordinary React renderer. For React measurements, run `VITE_OTHRYS_PROFILE=1 pnpm run build` (or the same flag with `pnpm run web:dev`). That one build flag aliases `react-dom/client` to `react-dom/profiling`, emits source maps for Chrome stack attribution and enables `ProfileSurface` in `web/src/app/profile-surface.tsx`. Rebuild without the flag after diagnosis. Normal builds bypass the profiler boundaries and collect only browser measurements.

Components and flows use the same API:

```tsx
<ProfileSurface name="chat" titanId={titanId}>
  <Chat />
</ProfileSurface>
```

`ProfileSurface` reports React's `actualDuration` through `recordUIRender({ surface, titanId, ms })`. This is render work associated with a commit, not the duration of DOM mutations. `page.react-commit` counts every observed commit, samples the first and every tenth duration per aggregate, and reports `samples`, `totalMs` and worst `ms`. Nested surfaces overlap; do not sum their render durations. The named boundaries cover workspace, chat, Settings, Oracle and sortable rendering.

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
