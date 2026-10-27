# Contributing to Pnyx

Every change starts with an issue that says what should change and why, so the reasoning stays on record. This applies to every change, typos included. For a bigger change, also describe the approach in the issue. You don't need to wait for a reply before opening the pull request. Report vulnerabilities privately through [SECURITY.md](SECURITY.md) instead of an issue.

Fork the repository, then clone your fork and create a branch:

```sh
git clone https://github.com/<your-user>/pnyx.git
cd pnyx
git remote add upstream https://github.com/leonardourci/pnyx.git
git switch -c your-change
pnpm install
pnpm run build
```

Use Node 22.13 or newer, the pnpm version pinned in `package.json`, and Chrome for the browser scenarios. Run Pnyx with an isolated `PNYX_HOME` and an unused port; see [Development](docs/development.md). Follow [AGENTS.md](AGENTS.md) for code conventions and the [front-end skill](.agents/skills/write-front-end/SKILL.md) for `web/` changes.

## Pull requests and checks

Commit with Conventional Commits, split by concern, with each area or module in its own commit. Then, in order:

1. **Open the pull request.** Push your branch and open a pull request against `main`. Explain the problem, the fix and how you checked it, and link its issue with a line such as `Closes #12`. Add images or a short recording for visible changes.
2. **Do the reviews your change needs, in order:** [review-code](.agents/skills/review-code/SKILL.md), [audit-tests](.agents/skills/audit-tests/SKILL.md), then [deslop](.agents/skills/deslop/SKILL.md). [Verification by change kind](docs/development.md#verification-by-change-kind) lists which ones each kind of change needs. Fix what they find, push the fixes, tick their boxes in the [PR template](.github/pull_request_template.md) and note the fixes in the description.
3. **Run `pnpm verify` last.** Every pull request needs it, docs-only ones included. Run it from your pushed PR branch with a clean working tree. It needs GitHub CLI signed in, and your branch must include your fork's `main`, so keep that synced with upstream; if your branch is behind, it prints the rebase command to run. It looks at the files you changed and picks the checks to match: none for docs, the changed tests for test files, and the full suite (lint, type checks, build, unit tests and browser scenarios) for code. Full runs on one machine take turns, so a second one waits for the first to finish. If it changes formatting, commit, push and run it again. Once the checks pass, it writes a hidden line in the PR description naming the commit it tested.

A pull request has two GitHub checks:

- **pnpm verify** runs on every push. It runs nothing itself; it confirms that `pnpm verify` passed on that exact commit and that the review boxes are ticked. A new push needs a new `pnpm verify` run.
- **The full test run** runs the test suite on GitHub. It starts only after a maintainer approves it.

Both must pass before merging. The repository owner reviews and merges with a merge commit. [Development](docs/development.md#verification) has the details, including which checks each kind of change runs and `pnpm verify --mechanical` for renames and moves.

## Reporting bugs

For bugs, include the Pnyx version, OS, harness, reproduction steps, expected behavior and actual behavior. Use made-up tasks and an isolated home for a reproduction; remove private paths, transcripts, tokens and account details from logs.
