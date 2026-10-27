# Contributing to Pnyx

Open an issue describing the problem or proposed change and wait for the repository owner's approval before starting. Typos, documentation fixes and hotfixes may skip the issue; explain the problem in the pull request instead. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Fork the repository, then clone your fork and create a branch:

```sh
git clone https://github.com/<your-user>/pnyx.git
cd pnyx
git remote add upstream https://github.com/leonardourci/pnyx.git
git switch -c your-change
pnpm install
pnpm run build
```

Use Node 22.13 or newer, the pnpm version pinned in `package.json`, and Chrome for browser journeys. Run Pnyx with an isolated `PNYX_HOME` and an unused port; see [Development](docs/development.md). Follow [AGENTS.md](AGENTS.md) for code conventions and the [front-end skill](.agents/skills/write-front-end/SKILL.md) for `web/` changes.

```sh
pnpm lint:fix
pnpm run lint
pnpm test
```

Use Conventional Commits, split by concern, with each area or module in its own commit. Open a pull request against `main` explaining the problem, fix and validation; link its issue with `Closes #n` when applicable. Include images or a short recording for visible changes.

Every PR, including documentation-only changes, needs `pnpm verify` passing locally on its clean, pushed head. Keep your fork's default branch synced with upstream and authenticate GitHub CLI for the upstream PR. Verification fetches origin's default branch and requires your branch to include it; it prints a rebase command if you need to update. It selects checks and reviews from the changed files, as listed in [Verification by change kind](docs/development.md#verification-by-change-kind). Complete the reviews it requires, in order: [review-code](.agents/skills/review-code/SKILL.md), [audit-tests](.agents/skills/audit-tests/SKILL.md), then [deslop](.agents/skills/deslop/SKILL.md). Tick their [PR template](.github/pull_request_template.md) boxes and record what they fixed. Verification records the tested commit in the PR description only after its checks pass and the required boxes are ticked. If formatting changes files, commit and push them, then rerun verification. A mechanical rename or move uses `pnpm verify --mechanical` with a declaration line in the PR description; see [Development](docs/development.md) for details and browser prerequisites.

GitHub checks must pass before merging. The repository owner reviews and merges with a merge commit.

For bugs, include the Pnyx version, OS, harness, reproduction steps, expected behavior and actual behavior. Use made-up tasks and an isolated home for a reproduction; remove private paths, transcripts, tokens and account details from logs.
