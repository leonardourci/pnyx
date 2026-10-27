---
name: write-ci-workflow
description: Create or change a GitHub Actions workflow in .github/workflows for Pnyx. Covers what the workflow proves, triggers and path filters that keep docs-only changes out of code checks, running safely on pull requests from forks, permissions, timeouts and concurrency, and checking a filter against real PR file lists. Read before adding or editing any workflow file.
---

# Write a CI workflow

A check that runs on changes that cannot affect it, or fails for reasons unrelated to the change, teaches people to ignore red. Pick every trigger and permission on purpose.

- [ ] Say first what the workflow proves (the `pnpm verify` marker, the test suite), then trigger it only on the inputs that can change that result: the source it checks, `package.json`, `pnpm-lock.yaml` and the workflow file itself. A check every PR needs, such as the `pnpm verify` marker check, takes no path filter.
- [ ] Keep docs-only changes out of code checks. GitHub applies `paths` patterns in order and the last match wins, so put `'!**/*.md'` after the positive patterns, then add back the Markdown that code reads: `'skills/**'` for the shipped skills and `'**/fixtures/**'`.
- [ ] Treat every pull request as untrusted, since anyone can open one from a fork. A `pull_request_target` workflow runs with base-branch secrets and permissions, so it must never check out, install or run PR code; read the PR through the API only, as `verify.yml` does. A workflow that runs PR code uses `pull_request` and starts only after a maintainer approves it.
- [ ] Grant the least `permissions` the job needs, declared at the top of the file, and pass `persist-credentials: false` to `actions/checkout` unless a later step pushes. Never print a secret or pass one to PR code.
- [ ] Set `timeout-minutes` on every job and a `concurrency` group per PR with `cancel-in-progress: true`, so a new push replaces the old run.
- [ ] Use a Node version the project supports and the pnpm version it pins, so CI fails for the same reasons a contributor's machine would.
- [ ] Before pushing, check the filter against real file lists from `gh pr view <number> --json files`: a merged docs-only PR must not trigger it, and a PR that changes the checked source must. Put both results in the PR description.
- [ ] Describe when the workflow runs and what it checks in `docs/development.md`, and update `CONTRIBUTING.md` if contributors see it as a PR check, in the same change.
