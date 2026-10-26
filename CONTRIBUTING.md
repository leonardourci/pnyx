# Contributing to Pnyx

Open an issue describing the problem or proposed change and wait for the repository owner's approval before starting.
Typos, documentation fixes and hotfixes may skip the issue; explain the problem in the pull request instead.
Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Fork the repository, then clone your fork and create a branch:

```sh
git clone https://github.com/<your-user>/pnyx.git
cd pnyx
git remote add upstream https://github.com/leonardourci/pnyx.git
git switch -c your-change
pnpm install
pnpm run build
```

Use Node 22.13 or newer, the pnpm version pinned in `package.json`, and Chrome for browser journeys.
Run Pnyx with an isolated `PNYX_HOME` and an unused port; see [Development](docs/development.md).
Follow [AGENTS.md](AGENTS.md) for code conventions and the [front-end skill](.agents/skills/write-front-end/SKILL.md) for `web/` changes.

```sh
pnpm lint:fix
pnpm run lint
pnpm test
```

Use Conventional Commits, split by concern, with each area or module in its own commit.
Open a pull request against `main` explaining the problem, fix and validation; link its issue with `Closes #n` when applicable.
Review the whole diff for correctness, integration and unnecessary code or prose using the review checklists linked in the PR template.
Record what those reviews fixed and include images or a short recording for visible changes.

Every PR, including documentation-only changes, needs `pnpm verify` passing locally on its clean, pushed head.
Fetch `origin/main` first; in a fork, point that local ref at the current upstream `main` before verification.
Authenticate GitHub CLI for your PR.
Verification selects checks by changed files and records the tested commit in the PR description.
If formatting changes files, commit and push them, then rerun verification.
See [Development](docs/development.md) for details and browser prerequisites.

GitHub checks must pass before merging.
The repository owner reviews and merges with a merge commit.

For bugs, include the Pnyx version, OS, harness, reproduction steps, expected behavior and actual behavior.
Use made-up tasks and an isolated home for a reproduction; remove private paths, transcripts, tokens and account details from logs.
