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

Run `pnpm lint:fix` to apply formatting.
Objects, destructuring patterns, type literals,
arrays, parameter lists and call arguments with more than one item use one item per line.
A single item may stay inline.
`pnpm run lint` checks the same rules without fixing them.

See [AGENTS.md](../AGENTS.md) for the layout and design rules.
`pnpm run lint` and `pnpm test` give deterministic verification.
`pnpm run web:dev` serves the Hydra through Vite.
The scenarios include the owner's browser journeys (`test/scenarios/page-journeys.test.ts`), which drive the built page in a headless Chrome of their own with temporary data; they need Chrome installed, or `PNYX_CHROME` set to its binary.
After building, `PNYX_BROWSER_TESTS=1 node --test test/chat-browser.test.ts` runs the chat’s long-history regression with an isolated headless `chrome-devtools-axi` session and temporary data; it needs that CLI and Chrome installed.

## Run a development server

```sh
pnpm dev
```

`pnpm dev` runs a Pnyx server with its own data folder (`~/.pnyx-dev`, or `PNYX_DEV_HOME`), so it never competes with your installed server for your Hydras, opening its `dev` Hydra under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web app in place as you edit `web/`.
Open the URL Vite prints; it forwards the Hydra's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).

## Verification

Run `pnpm verify` on a PR's pushed head before it merges.
It picks the checks from the files the branch changes against `origin/main` and prints what it picked and why: a back-end change (alone or with UI changes) runs `pnpm lint:fix`, the type check, ESLint, the build, the unit tests and the scenarios in `test/scenarios/`; a change only under `web/` runs the first four, the tests that import the web code and the browser journeys; a docs-only change runs nothing.
It keeps going when a step fails, and ends with one summary that gives each failed step's log.
A `lint:fix` that changed files counts as failed: commit them and run again.
When every step passed, the tree is clean and HEAD is the PR's head, it adds a hidden `<!-- pnyx-checks:v1 ... -->` line naming the tested commit and its git tree to the PR description; a rerun replaces it.

The "Checks ran for this commit" workflow (`.github/workflows/checks-required.yml`) runs for every PR and installs and builds nothing.
It reads the PR and fails unless that line names the PR head, so a new push voids it, with two exceptions: commits after the run that change only docs, and a head whose git tree a recorded run already tested, on this PR or on another PR linked to the commit.
Docs here means Markdown outside `skills/` and `test/`, since the shipped skills and test fixtures are read by Pnyx and its tests.
Docs-only PRs still need the marker from `pnpm verify`.
Only `pnpm verify` writes the line.
Anyone who can edit the description, or the check in their own PR, could forge a pass, so it is an honesty check, not a signature.

The Verification workflow runs `pnpm verify --checks-only` automatically on every PR's pushed head, with the pinned pnpm version and Chrome for browser tests.
It runs the selected checks with a read-only token and leaves the PR description unchanged.
Local verification and the marker check still apply.

## Review

Review the whole branch diff against its PR base, including documentation and shipped skills.
Use the `review-code` and `deslop-code` skills when they are available in your agent environment; the checks below also apply to a manual review.

- Correctness: check command examples against CLI help, task lifecycle rules, error handling and tests for changed behavior.
- Integration: follow each changed path through its callers, event log, server and UI where applicable; check documentation links and setup prerequisites.
- Clarity: remove dead code, unnecessary abstractions and comments that narrate obvious steps; keep prose short and concrete.

Apply [AGENTS.md](../AGENTS.md) and the [front-end conventions](../.agents/skills/write-front-end/SKILL.md) where they apply.
Report review findings, fixes and remaining validation gaps in the PR.
