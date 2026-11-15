# Contributing to Pnyx

An issue is where a change gets talked through and its decisions are recorded, so start there for anything worth discussing: say what should change and why. Typos, small doc fixes and hotfixes have little to discuss, so they can go straight to a pull request whose description records what changed and why; open an issue anyway if you want to talk it through. For a bigger change, also describe the approach in the issue. You don't need to wait for a reply before opening the pull request. Report vulnerabilities privately through [SECURITY.md](SECURITY.md) instead of an issue.

Fork the repository, then clone your fork and create a branch:

```sh
git clone https://github.com/<your-user>/pnyx.git
cd pnyx
git remote add upstream https://github.com/leonardourci/pnyx.git
git switch -c your-change
pnpm install
pnpm run build
```

Use Node 22.13 or newer and the pnpm version pinned in `package.json`. Run owner-facing trials with an isolated `PNYX_HOME` under portless when installed: `PNYX_HOME=<dir> portless <name>.pnyx pnyx-axi serve`. Choose a unique name, leave `--port` unset and share the URL portless prints. Without portless, use `--port 0`; automated tests keep random ports. See [Development](docs/development.md#owner-facing-trials). Follow [AGENTS.md](AGENTS.md) and the [follow-conventions skill](.agents/skills/follow-conventions/SKILL.md) for code conventions, including when to split a file, and the [front-end skill](.agents/skills/write-front-end/SKILL.md) for `web/` changes.

## Pull requests and checks

Commit with Conventional Commits, split by concern. Push the branch and open a draft pull request against `main`, following [write-pull-request](.agents/skills/write-pull-request/SKILL.md). Keep its Intent, Problem, Fix, Validation and Review sections current, link the issue, and include media for visible changes.

Run `pnpm verify` on the clean, pushed PR head. The shared verifier waits for the configured GitHub checks, then performs one fresh, read-only review using the repository's skills. Fix every finding, commit, push and rerun. The follow-up checks the fixes and their regressions. Three non-clean rounds stop for an owner decision. There are no self-ticked review boxes: the exact-commit marker and `pnpm exec verify status` show the evidence.

Use `pnpm verify --local` when CI cannot run. It runs the configured local commands and the same fresh review; its marker is visibly labeled ran locally. Commit any formatting changes and rerun on the new head.

The `verify` GitHub check validates that the marker names the PR head and records passed checks plus a clean review. The separate `Lint, build and tests` check runs on GitHub after a maintainer approves the `ci` environment; docs-only changes do not start it. The required status check is `verify`; it waits for the CI checks each change kind needs, while accepted local fallback records its own evidence. The owner merges with a merge commit. [Development](docs/development.md#verification) describes configuration, reviewer selection and owner-only decisions.

## CodeRabbit challenger review

After `pnpm verify` passes and CI is green on a PR that is ready for review, the owner or Hydra may request the challenger review with a PR comment: `@coderabbitai review`. Contributors and workers leave that request to them. CodeRabbit replaces the separate agent challenger before merge; the configured review skills still apply. Resolve each finding or answer it with a reason, then update the description and rerun verification after any fixes. A later review is requested explicitly again. `pnpm verify` neither requests nor requires CodeRabbit.

CodeRabbit reviews as a challenger, on the same three parts as every review (bugs, tests, simpler): it tries to break the change, names concrete failure scenarios with inputs, checks that the tests of a behaviour change would fail if the change were reverted (a behaviour-preserving refactor is the exception), looks for races, stale caches, cross-process state and data, privacy and permission leaks, asks whether each change is the clearest way to get the result (reuse over copies, no dead code, one place for each rule, no hand-written versions of what the stack provides, nothing hard to follow), and says plainly when there is nothing to flag. [.coderabbit.yaml](.coderabbit.yaml) disables automatic and incremental reviews, uses the assertive profile and keeps the summary in the walkthrough comment so the PR description and verification marker stay intact. Configured guideline additions are follow-conventions and review-code for all paths, audit-tests for application code, scripts and tests, write-front-end for `web/**` and write-ci-workflow for `.github/workflows/**`; CodeRabbit discovers `AGENTS.md` by default. It skips `pnpm-lock.yaml`. See the [configuration reference](https://docs.coderabbit.ai/reference/configuration) for the supported settings.

## Reporting bugs

For bugs, include the Pnyx version, OS, harness, reproduction steps, expected behavior and actual behavior. Use made-up tasks and an isolated home for a reproduction; remove private paths, transcripts, tokens and account details from logs.
