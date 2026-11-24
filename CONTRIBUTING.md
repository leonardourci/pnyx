# Contributing to Othrys

An issue is where a change gets talked through and its decisions are recorded, so start there for anything worth discussing: say what should change and why. Typos, small doc fixes and hotfixes have little to discuss, so they can go straight to a pull request whose description records what changed and why; open an issue anyway if you want to talk it through. For a bigger change, also describe the approach in the issue. You don't need to wait for a reply before opening the pull request. Report vulnerabilities privately through [SECURITY.md](SECURITY.md) instead of an issue.

Fork the repository, then clone your fork and create a branch:

```sh
git clone https://github.com/<your-user>/othrys.git
cd othrys
git remote add upstream https://github.com/leonardourci/othrys.git
git switch -c your-change
pnpm install
pnpm run build
```

Use Node 22.13 or newer (22.18 for `pnpm deslop`) and the pnpm version pinned in `package.json`. Run owner-facing trials with an isolated `OTHRYS_HOME` under portless when installed: `OTHRYS_HOME=<dir> portless <name>.othrys othrys serve`. Choose a unique name, leave `--port` unset and share the URL portless prints. Without portless, use `--port 0`; automated tests keep random ports. See [Development](docs/development.md#owner-facing-trials). Follow [AGENTS.md](AGENTS.md) and the [follow-conventions skill](.agents/skills/follow-conventions/SKILL.md) for code conventions, including when to split a file, and the [front-end skill](.agents/skills/write-front-end/SKILL.md) for `web/` changes.

## Pull requests and checks

Commit with Conventional Commits, split by concern. Push the branch and open a draft pull request against `main`, following [write-pull-request](.agents/skills/write-pull-request/SKILL.md). Keep its Intent, Problem, Fix, Validation and Review sections and its folded Intentional slop list current, link the issue and include media for visible changes.

Run `pnpm deslop` before marking the pull request ready; see [Verification](docs/development.md#verification) for the checks and CI approval steps. The owner runs deslop for pull requests from forks.

Both required checks, `deslop` and `Lint, build and tests`, must pass. The latter also runs `pnpm knip`, which rejects unused files, exports and dependencies. The owner reviews and merges with a merge commit.

## CodeRabbit challenger review

Limit CodeRabbit to one review per PR, even after fixes. Once the PR is ready for review and both required checks pass, only the owner or Titan may request the review by commenting `@coderabbitai review`. CodeRabbit replaces the separate agent challenger before merge, and the configured review skills still apply. `pnpm deslop` neither requests nor requires CodeRabbit.

If CodeRabbit refuses the request because of its quota, the owner or Titan may retry once after waiting as long as CodeRabbit specifies. If CodeRabbit refuses the retry, the PR can merge without a CodeRabbit review once both required checks pass and all review threads are resolved.

If CodeRabbit reviews the PR, fix each finding or reply with a reason. After any fixes, update the PR description and rerun verification.

CodeRabbit reviews as a challenger, on the same three parts as every review (bugs, tests, simpler): it tries to break the change, names concrete failure scenarios with inputs, checks that the tests of a behaviour change would fail if the change were reverted (a behaviour-preserving refactor is the exception), looks for races, stale caches, cross-process state and data, privacy and permission leaks, asks whether each change is the clearest way to get the result (reuse over copies, no dead code, one place for each rule, no hand-written versions of what the stack provides, nothing hard to follow), and says plainly when there is nothing to flag. [.coderabbit.yaml](.coderabbit.yaml) disables automatic and incremental reviews, uses the assertive profile and keeps the summary in the walkthrough comment. Configured guideline additions are follow-conventions for all paths, write-front-end for `web/**` and write-ci-workflow for `.github/workflows/**`; CodeRabbit discovers `AGENTS.md` by default. It skips `pnpm-lock.yaml`. See the [configuration reference](https://docs.coderabbit.ai/reference/configuration) for the supported settings.

## Reporting bugs

For bugs, include the Othrys version, OS, harness, reproduction steps, expected behavior and actual behavior. Use made-up tasks and an isolated home for a reproduction; remove private paths, transcripts, tokens and account details from logs.
