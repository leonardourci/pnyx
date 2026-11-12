# Development

[Back to Pnyx](../README.md)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the issue, review and merge process.

## Build and test

Use Node 22.13 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

CSS uses the recommended Biome rules with Tailwind v4 parsing enabled in `biome.json`. The editor, `pnpm lint:css`, `pnpm run lint`, full `pnpm verify` runs and CI share this config. CSS formatting is unchanged. The specificity-order rule is disabled because it compares unrelated components; the important-style rule is disabled because layout overrides and reduced-motion accessibility use `!important`. Other CSS warnings fail verification.

Run `pnpm lint:fix` to apply formatting. Objects, destructuring patterns, type literals, arrays, parameter lists and call arguments with more than one item use one item per line. A single item may stay inline. `pnpm run lint` checks the same rules without fixing them.

`pnpm run build` compiles into its own `dist.next.<pid>` folder and renames it to `dist` only after the whole build passed, so a failed or interrupted build leaves the last working `dist`.

Imports across folders use the `package.json` aliases: `#<folder>/<file>.ts` resolves to `src/` and `#web-<folder>/<file>` to `web/src/`. Built code resolves `#…` to `dist/`, so anything that runs TypeScript from `src/` passes `--conditions=source`, or its `#` imports load the built files. The test launcher, `pnpm dev:server` and the Vite scripts pass it. A child the server starts with `execFile` and a login service installed from source take it from `SOURCE_CONDITIONS` in `src/app/source-conditions.ts`. The session-start hook adds it when its CLI is a `.ts` file.

See [AGENTS.md](../AGENTS.md) for the layout and design rules, and [follow-conventions](../.agents/skills/follow-conventions/SKILL.md#files-and-concerns) for when to split a file. `pnpm run lint` and `pnpm test` give deterministic verification. The test launcher isolates each file with temporary data and harness folders, discards inherited agent identity, and limits process concurrency. See [Testing](testing.md) for isolation details and focused test commands. `pnpm run web:dev` serves the Hydra through Vite. The default test suite has no browser tests: check a page change in the local preview and show it in the pull request's screenshots. [Testing](testing.md#native-clipboard-regression) also describes the opt-in native clipboard regression.

Owner actions in the app run in the server, which holds each Hydra in memory and is its only writer, so no command waits on another writer's lock. A validation or permission refusal returns its reason at once. The writer applies a batch to its own loaded state and retains changed properties for the lifecycle rules' before-state; its saved snapshot must match a cold replay of the log.

A dirty Hydra saves its snapshot once per minute and at shutdown. A worker thread reads the durable log and cache, replays the tail and serializes, syncs and atomically replaces the cache. The server does not copy its in-memory state to the worker. One worker runs for the whole daemon; saves queue in arrival order across Hydras. Online repair uses a separate staging file, so it cannot overwrite a worker's pending cache. Shutdown waits for any in-flight save and the final save before releasing the Hydra. A failed cache write removes its staging file; cleanup failures are logged separately without hiding the save error. The event log remains authoritative.

The browser caches confirmed Hydra state under the installation and Hydra URL. The former identity-only `pnyx:<identity>:hydra-state` cache is removed on access; an older tab without a current cache loads a fresh snapshot from the server. Snapshot recovery retains live usage and spend for the same agent session until its next reading arrives; replacement sessions discard them. Live readings stay out of the saved state.

The offline badge appears after the page detects a connection failure or a missed heartbeat and clears when its WebSocket opens again. Initial loading, switching Hydras and resynchronizing state do not imply that the page is offline. Actions still wait for the selected Hydra's subscription to be ready. The socket retries automatically with backoff capped at ten seconds and no attempt limit. Returning to a visible page, restoring it from the browser cache or coming back online replaces a stale connection immediately. Restarting or upgrading the server reloads the selected Hydra's state and conversation subscriptions automatically. A rejected handshake refreshes the page token for the same installation; an installation change or missing token asks for a page reload.

Hydra subscriptions have their own loading deadline and retry transient failures automatically, even while socket heartbeats still succeed. A permanent refusal, such as a missing Hydra or denied access, shows its reason and a retry for that Hydra. Ordinary command errors keep their own message and a Dismiss button.

Harvested chat records are identified by session, native message and part. Replacing a transcript file or losing its harvest cursor does not duplicate its messages. Conversation readers also hide older duplicate harvests without changing the append-only log; separate sends with identical words stay separate.

Completed native replies and explicit chat updates remain visible when a later turn ends quietly. During an owner's running turn, its latest commentary stays visible as streaming text becomes a native transcript record. Finished turns fold commentary into progress notes. A running turn keeps its tool calls and thinking in progress below its latest message, never as chat rows. Native commentary does not become a background notification. Older archived records without completion metadata retain their previous conservative rendering.

Hydra thread subscriptions keep their loaded history on the server. Subscriptions that read a transcript file reuse the saved page and its conversation projection while only live text grows. Transcript file changes, relevant state or settings changes, session changes and explicit history requests rebuild that base. The first live text update after idle is sent immediately; sustained text updates coalesce within 80 ms. Status and latest-message refreshes keep their 200 ms cadence. The reveal clock caps an elapsed frame at 100 ms so a suspended frame resumes gradually. Re-reading a thread keeps its existing subscription. After a reconnect, the page sends its session and oldest loaded entry so the server restores that range before replacing the conversation. A changed session starts fresh; repeated history cursors fail explicitly. Each thread page carries reconciled conversation entries, turn timings and action folds. Continuation chunks carry a boolean, and injected instruction blocks are hidden before transport. The browser renders that projection and keeps only its unsent previews locally. The server also sends Hydra's held inputs, pending operations and queue state; the browser uses those facts to place its unsent previews.

A conversation page counts as delivered only when the socket accepts it. If the socket buffer is full, the server retains the newest page for that subscription and retries when it can send again; a newer page replaces the pending one. Closing a tab cancels its pending delivery. Replacing a subscription cancels its old page and responds to every pending read with an error, retrying those errors if the socket is still backed up. A resync refreshes its conversation as well as its state snapshot, so the final text does not depend on another content change or a reload.

State, working status, current actions and Hydra lists recover when the socket drains, without waiting for another event. Pending message and action maps merge sparse updates and retain explicit removals. The server sends a recovery snapshot and current status facts as one batch, so a large snapshot cannot repeatedly block its queue state. Current native work takes precedence over the timestamp of the last call written to the transcript; timestamp filtering applies to transcript-only actions.

Live replies retain every transport part through handoff to the native transcript. Native history targets 60 parts per page, with at most 1,000 UTF-16 code units per part. If the target falls inside a message, the page includes that message's remaining parts, so it can exceed 60. Native reads remain bounded to a 10 MiB window, and retained-history restoration stops after 1,000 pages.

## Diagnostic logs

The server writes one JSON line per action to `logs/<UTC date>.jsonl` under `PNYX_HOME`, for debugging Pnyx itself. Logs are separate from `events.jsonl`, never change Hydra state and are never shown in the page. Only the server writes the folder; another `pnyx-axi` process prints its warnings and errors on its own stderr. The installed service sends stdout and stderr to `service.log`, which holds `serve`'s start message, anything Node prints itself, such as a crash, and any warning or error the log folder could not take.

Server code logs through one function, `log({ operation, ...fields })` in `src/app/diagnostics.ts`, and the page through its own `log()` in `web/src/app/log.ts`, with the same line type and level rule, which sends its lines to the server in batches over the page's WebSocket. A call with neither `detailed` nor `level` writes an action's line when the action ends. `detailed: true` marks a line written only under Detailed; below that the call returns before building the line. `level: 'warn'` or `level: 'error'` marks a failure, and an error line requires the thrown value as `error`. The level is held in memory and updated when the setting changes, so a call never reads the settings file.

Each line has `v`, `at` (UTC), `source` (`server` or `web`), `operation` and the ids that apply: `hydraId`, `taskId`, `sessionId`, `correlationId`, `operationId` and `eventSeq`. A server line adds the process's resident memory (`rss`), except a detailed one, which the lines around it cover; `server.start` and every warning and error add the process id (`pid`). A page line adds its `tab`, and the server places it at its age on the page's monotonic clock, so a line that waited for the socket keeps its time without trusting the page's wall clock. A line keeps only the fields the line type lists, each text cut to 200 characters. The line that ends an action has its duration in `ms`, from the monotonic clock, and sizes where they matter: `bytes` written or sent, in UTF-8, and the socket's `backlog`. `name` narrows the operation, such as the command, tool and its subcommand (never an id the command takes, so `card <id>` is `card`), message or event type, or the file a warning is about; a command line from the owner's terminal is logged as `actor: cli` on the Hydra it runs on. Warnings and errors add `level`, and `error` (message, name, stack and code when available, or a bounded inspection of anything else thrown, `undefined` included for an error), and always have an `operationId`, which a failed retry shares. While logging is On or Detailed, every 30 seconds the `process` line records the server's CPU, event-loop delay past its 20 ms sampling interval and use, heap and garbage-collection pauses; one `agent.memory` line lists every agent the server runs, for Hydras, workers and the helper, with its `hydraId`, `taskId`, `sessionId` and the resident memory of its whole process tree, from one `ps` listing; and each open page writes `page.memory`, read when the browser is idle, with its chat's size (`chatChars`, the length of the socket frames that brought it), its `messages`, its DOM `elements` and, in Chromium only, its JS heap (`heapUsed`). Lines carry identifiers, never prompts, credentials or request bodies, but error messages, stacks and some warnings' `name` hold local paths, so sanitize logs before sharing them.

The Logs setting chooses Off (warnings and errors only), On (the default, one line per action) or Detailed, for debugging streaming: also a line per live chat update and socket message, each page update with the reveal frames drawn since the last and the slowest of them (`frames`, `worstFrameMs`), a `page.frame` line only for a reveal frame longer than one and a half display frames, and an `agent.memory` reading of the turn's agent at the start and end of each turn. Pnyx keeps 7 days and 500 MB by default, deleting older days first, at start, when the days or size setting changes and every minute. Today's file is never deleted for size: once it alone passes the cap it takes only warnings and errors until the day ends, after one `logs.full` warning, and once it passes twice the cap it takes nothing more; each cleanup then writes one `logs.dropped` warning with how many warnings and errors it dropped. `pnyx-axi logs clean` deletes every file now. `pnyx-axi debug performance` reads the lines back as counts and durations per action, memory over time and the slowest actions, and `jq -R 'fromjson? | select(.hydraId == "lab")' "$PNYX_HOME"/logs/*.jsonl` selects one Hydra's lines, skipping a line still being written.

## Run a development server

```sh
pnpm dev
```

`pnpm dev` runs a Pnyx server with its own data folder (`~/.pnyx-dev`, or `PNYX_DEV_HOME`), so it never competes with your installed server for your Hydras, opening its `dev` Hydra under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web app in place as you edit `web/`. Open the URL Vite prints; it forwards the Hydra's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).

## Verification

Run `pnpm verify` on a PR's pushed head before it merges. It discovers and fetches origin's default branch, then stops if your branch does not include it. It prints the `git rebase` command for you to run; it never rebases automatically.

Verification picks checks and reviews from the files changed against that default branch. UI and back-end changes run the full suite. Markdown changes require `deslop`; shipped skills also run the tests that read them. Test-only changes require `audit-tests` and run the changed tests with static checks and a build. Mixed changes take the union. Verification continues after a check fails and prints a summary with log paths. Lint failures also print the issues the fixer could not resolve. Review and commit any automatic fixes, push them, and rerun on the clean PR head.

### Verification by change kind

`pnpm verify` refuses descriptions with missing or empty Problem, Fix, Validation or Review sections, or unchanged template placeholders. Review checkboxes alone do not fill the Review section. Follow [write-pull-request](../.agents/skills/write-pull-request/SKILL.md) and update the description after every push.

`pnpm verify` prints the changed path groups, required review boxes and selected checks. Tick only the required `Ran` boxes after completing those checklists; other template boxes may stay unticked.

| Change kind | Required reviews | Checks |
| --- | --- | --- |
| Files under `docs/`, or Markdown outside shipped skills and `fixtures/` folders | `deslop` | None |
| Shipped skill Markdown under `skills/` | `deslop` | Build and tests that read the shipped skills |
| Test files (`*.test.ts`) | `audit-tests` | Lint fixes, type checks, ESLint, build when needed, and the changed test files |
| UI or back-end code, configuration, test helpers or fixtures | `review-code`, `audit-tests`, `deslop` | Full suite: lint fixes, type checks, ESLint, CSS lint, build, unit tests and scenarios |
| Explicit mechanical rename or move | `deslop` | Full suite |

For a mechanical rename or move, run `pnpm verify --mechanical` and put exactly one standalone line, `Change: mechanical (rename)` or `Change: mechanical (move)`, in the PR description. The flag requires the visible declaration and records it in the verification marker. It changes only the required reviews and always runs the full suite. `--mechanical` cannot be combined with `--checks-only`, which never reads or edits the PR description.

### Reviews and the marker

Verification lists the required checklists in order: [review-code](../.agents/skills/review-code/SKILL.md), [audit-tests](../.agents/skills/audit-tests/SKILL.md), then [deslop](../.agents/skills/deslop/SKILL.md). Complete those it selects, fix findings, tick their matching PR boxes and note fixes or no findings in the description. Agents carry out these steps themselves. The checklists are a declared review, not something the command can perform or prove automatically.

Only when every selected check passes, the tree stays clean, HEAD matches the pushed PR head and the required boxes are ticked does verification write the hidden `<!-- pnyx-checks:v1 ... -->` marker. The marker records the tested commit and git tree, plus a mechanical declaration when used; a rerun replaces it.

Use `pnpm verify --checks-only` when the environment has read-only GitHub access. It runs the same freshness check and automated checks, including local lint fixes, and prints the review checklist paths. It never reads or edits the PR description and never writes a marker. A pass requires successful checks, a clean working tree and unchanged HEAD. Review declarations and the normal marker still belong to the PR readiness process.

The "pnpm verify" check in the "Verify" workflow (`.github/workflows/verify.yml`) runs for every PR, including a stacked PR whose base is another PR's branch, and installs and builds nothing. It runs on `pull_request_target` and checks out its checker scripts from the default branch, so PR code is never checked out. It checks the same description requirements, reads the PR, derives the required review boxes from the PR files (for a stacked PR, its own diff against its base) and requires them to remain ticked, and fails unless the marker names the PR head, so a new push voids it, with two exceptions: commits after the run that change only docs, and a head whose git tree a recorded run already tested, on this PR or on another PR linked to the commit. Docs here means files under `docs/` and Markdown outside `skills/` and any `fixtures/` folder, since the shipped skills and test fixtures are read by Pnyx and its tests. Docs-only PRs still need the marker from `pnpm verify`. Only `pnpm verify` writes the line. Anyone who can edit the description could forge a pass, so it is an honesty check, not a signature.

The "Lint, build and tests" check (`.github/workflows/tests.yml`) runs the typecheck, lint, build, unit tests and flows on GitHub. It runs on `pull_request`, forks included, with a read-only token and no secrets, and starts only after a maintainer approves it in the `ci` environment. A newer push cancels the older run. A docs-only change skips the tests, using the same selection as `pnpm verify`, and still reports success. It does nothing while the repository is private.

Verification does not merge a PR. Merging requires explicit approval.

## Review

Review the whole branch diff against its PR base, including documentation and shipped skills. Complete the checklists `pnpm verify` requires, in order: [review-code](../.agents/skills/review-code/SKILL.md), [audit-tests](../.agents/skills/audit-tests/SKILL.md), then [deslop](../.agents/skills/deslop/SKILL.md). Apply [AGENTS.md](../AGENTS.md) and the [front-end conventions](../.agents/skills/write-front-end/SKILL.md) where they apply. Record findings, fixes and pending checks in the PR description, then tick the matching required review boxes.
