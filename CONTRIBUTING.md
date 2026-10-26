# Contributing to Pnyx

Open a GitHub issue describing the problem or proposed change, and wait for a quick yes from the repository owner before starting. Typos, docs fixes and hotfixes may skip the issue; explain the problem in the pull request instead.

Fork the repository and work on a branch. Follow the [README](README.md#install) to install dependencies and build, and [AGENTS.md](AGENTS.md) for the project conventions. Use an isolated `PNYX_HOME` and an unused port when running Pnyx; tests use temporary homes and fixtures.

Open a pull request against `main` with the problem, the fix and how you validated it. Include `Closes #n` when it has an issue. Complete the three review checkboxes in the [PR template](.github/pull_request_template.md), following the linked checklists, and note anything those reviews fixed.

Every PR needs `pnpm verify` passing locally on its pushed head. Run it from a clean checkout with `origin/main` fetched and GitHub CLI authenticated for your PR. It selects checks for the changed files and writes the hidden verification marker into the PR description only when its requirements pass. If formatting changes files, commit and push them, then run it again. Docs-only PRs also run verify and need the marker, even when no build or tests are selected. See [Development](README.md#development) for check selection and browser prerequisites.

GitHub checks must pass before merging. The Verification workflow automatically runs the selected checks for every PR; that run supplements local verification. The repository owner reviews and merges PRs into `main` with a merge commit.
