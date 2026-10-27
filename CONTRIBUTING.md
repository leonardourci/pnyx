# Contributing to Pnyx

Open a GitHub issue describing the problem or proposed change, and wait for a quick yes from the repository owner before starting. Typos, docs fixes and hotfixes may skip the issue; explain the problem in the pull request instead.

Fork the repository and work on a branch. Follow the [README](README.md#install) to install dependencies and build, and [AGENTS.md](AGENTS.md) for the project conventions. Use an isolated `PNYX_HOME` and an unused port when running Pnyx; tests use temporary homes and fixtures.

Open a pull request against `main` with the problem, the fix and how you validated it. Include `Closes #n` when it has an issue. Complete the required review checkboxes in the [PR template](.github/pull_request_template.md), following the linked checklists, and note anything those reviews fixed.

Every PR needs `pnpm verify` passing locally on its pushed head. Run it from a clean checkout with `origin/main` fetched and GitHub CLI authenticated for your PR. It selects checks for the changed files and writes the hidden verification marker into the PR description only when its requirements pass. If formatting changes files, commit and push them, then run it again. Docs-only PRs also run verify and need the marker, even when no build or tests are selected. See [Development](README.md#development) for check selection and browser prerequisites.

GitHub checks must pass before merging. The Verification workflow automatically runs the selected checks for every PR; that run supplements local verification. The repository owner reviews and merges PRs into `main` with a merge commit.

## Verification by change kind

Run `pnpm verify` on the clean, pushed PR head. It prints the changed path groups, required review boxes and selected checks. Tick only the required `Ran` boxes after completing those checklists; other template boxes may stay unticked. Mixed changes take the union of their requirements.

| Change kind | Required reviews | Checks |
| --- | --- | --- |
| Files under `docs/`, or Markdown outside shipped skills and `fixtures/` folders | `deslop` | None |
| Shipped skill Markdown under `skills/` | `deslop` | Build and tests that read the shipped skills |
| Test files (`*.test.ts`) | `audit-tests` | Lint fixes, type checks, ESLint, build when needed, and the changed test files |
| UI or back-end code, configuration, test helpers or fixtures | `review-code`, `audit-tests`, `deslop` | Full suite: lint fixes, type checks, ESLint, build, unit tests and scenarios |
| Explicit mechanical rename or move | `deslop` | Full suite |

For a mechanical rename or move, run `pnpm verify --mechanical` and put exactly one standalone line, `Change: mechanical (rename)` or `Change: mechanical (move)`, in the PR description. The flag requires the visible declaration and records it in the verification marker. It changes only the required reviews and always runs the full suite. `--mechanical` cannot be combined with `--checks-only`, which never reads or edits the PR description.

Verification does not merge a PR. Merging requires explicit approval.
