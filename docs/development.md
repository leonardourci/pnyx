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

Run `pnpm lint:fix` to apply formatting. Objects, destructuring patterns, type literals, arrays, parameter lists and call arguments with more than one item use one item per line. A single item may stay inline. `pnpm run lint` checks the same rules without fixing them.

Imports across folders use the `package.json` aliases: `#<folder>/<file>.ts` resolves to `src/` and `#web-<folder>/<file>` to `web/src/`. Built code resolves `#…` to `dist/`, so anything that runs TypeScript from `src/` passes `--conditions=source`, or its `#` imports load the built files. The test launcher, `pnpm dev:server` and the Vite scripts pass it. A child the server starts with `execFile` and a login service installed from source take it from `SOURCE_CONDITIONS` in `src/app/source-conditions.ts`. The session-start hook adds it when its CLI is a `.ts` file.

See [AGENTS.md](../AGENTS.md) for the layout and design rules. `pnpm run lint` and `pnpm test` give deterministic verification. The test launcher isolates each file with temporary data and harness folders, discards inherited agent identity, and limits process concurrency. See [Testing](testing.md) for isolation details and focused test commands. `pnpm run web:dev` serves the Hydra through Vite. The test suite has no browser tests: check a page change in the local preview and show it in the pull request's screenshots.

Owner actions in the app keep their preview while another writer holds the Hydra lock. The server reports “Checking…” and retries with the same attempt or event ID, until the page's command deadline (140 seconds for replies, answers and agent settings; 60 seconds for ordinary edits). If that attempt still cannot acquire the lock, the page keeps checking and renews the same safe request. Lock probes never wait on the server thread. A validation or permission refusal still returns its reason immediately. The writer applies a batch to its own loaded state and retains changed properties for the lifecycle rules' before-state; its saved snapshot must match a cold replay of the log.

## Run a development server

```sh
pnpm dev
```

`pnpm dev` runs a Pnyx server with its own data folder (`~/.pnyx-dev`, or `PNYX_DEV_HOME`), so it never competes with your installed server for your Hydras, opening its `dev` Hydra under `node --watch`, which restarts it when server code changes, and the Vite dev server, which updates the web app in place as you edit `web/`. Open the URL Vite prints; it forwards the Hydra's WebSocket to the dev server on port 4319 (set `PNYX_DEV_PORT` to change it).

## Verification

Run `pnpm verify` on a PR's pushed head before it merges. It discovers and fetches origin's default branch, then stops if your branch does not include it. It prints the `git rebase` command for you to run; it never rebases automatically.

Verification picks checks and reviews from the files changed against that default branch. UI and back-end changes run the full suite. Markdown changes require `deslop`; shipped skills also run the tests that read them. Test-only changes require `audit-tests` and run the changed tests with static checks and a build. Mixed changes take the union. Verification continues after a check fails and prints a summary with log paths. Lint failures also print the issues the fixer could not resolve. Review and commit any automatic fixes, push them, and rerun on the clean PR head.

### Verification by change kind

`pnpm verify` prints the changed path groups, required review boxes and selected checks. Tick only the required `Ran` boxes after completing those checklists; other template boxes may stay unticked.

| Change kind | Required reviews | Checks |
| --- | --- | --- |
| Files under `docs/`, or Markdown outside shipped skills and `fixtures/` folders | `deslop` | None |
| Shipped skill Markdown under `skills/` | `deslop` | Build and tests that read the shipped skills |
| Test files (`*.test.ts`) | `audit-tests` | Lint fixes, type checks, ESLint, build when needed, and the changed test files |
| UI or back-end code, configuration, test helpers or fixtures | `review-code`, `audit-tests`, `deslop` | Full suite: lint fixes, type checks, ESLint, build, unit tests and scenarios |
| Explicit mechanical rename or move | `deslop` | Full suite |

For a mechanical rename or move, run `pnpm verify --mechanical` and put exactly one standalone line, `Change: mechanical (rename)` or `Change: mechanical (move)`, in the PR description. The flag requires the visible declaration and records it in the verification marker. It changes only the required reviews and always runs the full suite. `--mechanical` cannot be combined with `--checks-only`, which never reads or edits the PR description.

### Reviews and the marker

Verification lists the required checklists in order: [review-code](../.agents/skills/review-code/SKILL.md), [audit-tests](../.agents/skills/audit-tests/SKILL.md), then [deslop](../.agents/skills/deslop/SKILL.md). Complete those it selects, fix findings, tick their matching PR boxes and note fixes or no findings in the description. Agents carry out these steps themselves. The checklists are a declared review, not something the command can perform or prove automatically.

Only when every selected check passes, the tree stays clean, HEAD matches the pushed PR head and the required boxes are ticked does verification write the hidden `<!-- pnyx-checks:v1 ... -->` marker. The marker records the tested commit and git tree, plus a mechanical declaration when used; a rerun replaces it.

Use `pnpm verify --checks-only` when the environment has read-only GitHub access. It runs the same freshness check and automated checks, including local lint fixes, and prints the review checklist paths. It never reads or edits the PR description and never writes a marker. A pass requires successful checks, a clean working tree and unchanged HEAD. Review declarations and the normal marker still belong to the PR readiness process.

The "pnpm verify" check in the "Verify" workflow (`.github/workflows/verify.yml`) runs for every PR and installs and builds nothing. It runs on `pull_request_target`, so the workflow and its checker scripts come from the base branch and PR code is never checked out. It reads the PR, derives the required review boxes from the PR files and requires them to remain ticked, and fails unless the marker names the PR head, so a new push voids it, with two exceptions: commits after the run that change only docs, and a head whose git tree a recorded run already tested, on this PR or on another PR linked to the commit. Docs here means files under `docs/` and Markdown outside `skills/` and any `fixtures/` folder, since the shipped skills and test fixtures are read by Pnyx and its tests. Docs-only PRs still need the marker from `pnpm verify`. Only `pnpm verify` writes the line. Anyone who can edit the description could forge a pass, so it is an honesty check, not a signature.

The "Lint, build and tests" check (`.github/workflows/tests.yml`) runs the typecheck, lint, build, unit tests and flows on GitHub. It runs on `pull_request`, forks included, with a read-only token and no secrets, and starts only after a maintainer approves it in the `ci` environment. A newer push cancels the older run. A docs-only change skips the tests, using the same selection as `pnpm verify`, and still reports success. It does nothing while the repository is private.

Verification does not merge a PR. Merging requires explicit approval.

## Review

Review the whole branch diff against its PR base, including documentation and shipped skills. Complete the checklists `pnpm verify` requires, in order: [review-code](../.agents/skills/review-code/SKILL.md), [audit-tests](../.agents/skills/audit-tests/SKILL.md), then [deslop](../.agents/skills/deslop/SKILL.md). Apply [AGENTS.md](../AGENTS.md) and the [front-end conventions](../.agents/skills/write-front-end/SKILL.md) where they apply. Record findings, fixes and pending checks in the PR description, then tick the matching required review boxes.
