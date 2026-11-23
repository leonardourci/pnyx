---
name: write-ci-workflow
description: Create or change a GitHub Actions workflow in .github/workflows for Othrys. Covers what the workflow proves, triggers and scope selection that keep docs-only changes out of code checks, running safely on pull requests from forks, permissions, timeouts and concurrency, and checking a filter against real PR file lists. Read before adding or editing any workflow file.
---

# Write a CI workflow

A check that runs on changes that cannot affect it, or fails for reasons unrelated to the change, teaches people to ignore red. Pick every trigger and permission on purpose.

- [ ] Follow [Verification](../../../docs/development.md#verification) for Othrys's scope policy. Say first what the workflow proves. Keep `Tests` on `pull_request` without path filters or an `edited` trigger, so every PR gets a scope decision and description edits start no gated runs.
- [ ] Treat every pull request as untrusted. Keep permissions read-only and `persist-credentials: false`. The scope job installs the selector without package lifecycle hooks. A PR that edits `tests.yml` or `deslop.config.json` changes its own scope; review those edits. Tests and builds wait for approval of the `ci` environment. A `pull_request_target` or `workflow_run` job must never check out or execute PR code.
- [ ] Set `timeout-minutes` on every job and a `concurrency` group per PR with `cancel-in-progress: true`, so a new push replaces the old run.
- [ ] Use a Node version the project supports and the pnpm version it pins, so CI fails for the same reasons a contributor's machine would.
- [ ] Before pushing, exercise the scope decision against real file lists from `gh pr view <number> --json files`: a merged docs-only PR must skip tests, and a PR that changes the checked source must choose full CI. Put both results in the PR description.
- [ ] Describe when the workflow runs and what it checks in `docs/development.md`, and update `CONTRIBUTING.md` if contributors see it as a PR check, in the same change.
