---
name: review-code
description: Review a Pnyx diff or branch as an inspector before a PR, for correctness, repository conventions, dead code, failure handling, comments and behavioral coverage, returning numbered findings with a severity and a suggested fix each.
---

# Review code

The reviewer is an inspector: it reads the diff, runs the checks and returns numbered findings, each with a suggested fix. Applying them is a separate step, done by whoever asked for the review after checking each finding. A review does not authorize commits, pushes or merges.

Each finding is tagged:

- **Must fix**: a bug, or a break of a rule in `AGENTS.md` or this checklist. Items below marked must fix always report at this severity.
- **Recommended**: a judgment call the author can accept, change or decline with a reason.

## Before reading the diff

- [ ] Diff against the branch the PR targets, including uncommitted changes. A stacked PR reviews against its parent branch, not `main`.
- [ ] Read the intended behavior, `AGENTS.md` and [follow-conventions](../follow-conventions/SKILL.md). For `web/`, also read [write-front-end](../write-front-end/SKILL.md); for a cleanup or refactor, [deslop](../deslop/SKILL.md).
- [ ] If the tree mixes work from another branch, drop changes the base already has, unless the drift is deliberate here.

## The checklist

- [ ] Trace each changed path from input to observable result, including empty input, invalid input, failures, cancellation and recovery. Check permissions at the write boundary and keep useful error feedback.
- [ ] Check Pnyx's boundaries (must fix): only `pnyx-axi` writes Hydra state; the event log stays append-only; the reducer stays pure and deterministic; snapshots and Oracle indexes stay derived. Hooks stay fast and exit 0, never wait on the network, and print only the session-start summary. Integrations use their own supported read and reply interfaces.
- [ ] Keep one owner for each fact and one place for each shared decision. Two flags or caches holding the same fact drift apart. Before accepting a new helper or component, search for an existing one shaped like it. Keep feature code in its feature folder; avoid speculative abstractions and dependencies.
- [ ] Remove dead branches (an arm an earlier guard handled, a check on an already narrowed value, a fallback for a value that is always present) and dead code (unused exports, references to removed features, debug output, TODO markers). Search for them; don't guess.
- [ ] Check types and function contracts. Functions take one destructured object parameter, except no-argument functions and external API contracts (must fix). TypeScript stays erasable. An `any`, a cast or a non-null assertion that hides an unchecked value is must fix; a narrowing TypeScript cannot infer, with a short reason, is fine.
- [ ] New and changed code reads as plain named steps, with no cryptic shorthand (must fix): no conditional spread (`...(x ? { a } : {})`), no logical assignment picking a value (`??=`, `||=`, `&&=`), no `||` or `??` default whose case the names don't make obvious, no bare `void` on a promise, no `.then` chain and no `for (;;)` or `while (true)` wait. Existing uses are not rewritten unless the change touches them. Suggest the plain-steps version.
- [ ] Name a value with meaning beyond its literal (a timeout, a limit, a retry count) as a constant. Two sites repeating the same value without a shared constant is must fix.
- [ ] Check errors stay visible. A caught and dropped error with no reason given and no log or user feedback is must fix. A failure the user should see keeps its message through the CLI, server and page.
- [ ] Check timers, watchers, locks and subprocesses for cleanup on failure and shutdown. Keep ordering, retry limits and session ownership across asynchronous work.
- [ ] Reject unbounded waits, including `for (;;)` and `while (true)` polling without a deadline or attempt limit. Bad: `while (true) { if (await ready()) break }`. Good: `await waitFor({ ready, timeoutMs: 5000 })`, where timeout fails with the last observed state.
- [ ] Do not match exact event sequence numbers read in separate operations: another writer can append between reads. Bad: `assert.equal(reply.seq, previouslyRead.seq + 1)`. Good: find the reply by its returned ID in one event snapshot, then assert its payload and causal link.
- [ ] In tests, use IDs returned by setup or the operation under test. Bad: `taskShow({ id: 'task-1' })` after creating a task. Good: `taskShow({ id: created.id })`. Fixed IDs belong only in synthetic input whose identity is the contract.
- [ ] For UI changes, check loading, empty and error states, keyboard access and the existing UI primitives. Use Hydra, Oracle and inscribe consistently.
- [ ] Match changed behavior to tests using [audit-tests](../audit-tests/SKILL.md). Read the assertions; a test name alone proves nothing. A bug fix ships a test that fails with only the fix reverted (must fix).
- [ ] Check docs, CLI help and hints describe the resulting behavior, in the same change (must fix).
- [ ] Review comments and prose using `deslop`. Keep a comment only for a constraint or non-obvious reason; remove narration and stale claims (must fix). Keep each prose paragraph on one source line.
- [ ] Run `pnpm verify` for the branch's checks. The lint fixer cannot settle unused variables or lines over 100 characters; report those. Respect any explicit test hold and report skipped checks as pending.

## Reporting

List findings by importance, must fix first, each with its tag, file and line, the failing behavior or broken rule, and a suggested fix. Keep observations the author should decide apart from findings to apply. Report suites plainly: a red suite is red, with the failing lines. Every must-fix finding is resolved, and each declined recommendation gets a reason. Once complete, tick **Ran `review-code`** in the PR and describe what you fixed (or say no findings).

When asked to open or update a PR for a branch this review has not covered, say so and offer to run it first.

For an agent: perform the checklist yourself when assigned the review; do not merely tell the developer to do it. Report findings before editing when asked only to inspect.
