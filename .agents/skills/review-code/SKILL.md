---
name: review-code
description: Review a Pnyx diff or branch as an inspector before a PR, in three parts, bugs, tests and simpler (reuse, dead code, duplicated rules, hand-written versions of what the stack provides, hard-to-follow code), returning numbered findings with a severity and a suggested fix each.
---

# Review code

The reviewer is an inspector: it reads the diff, runs the checks and returns numbered findings, each with a suggested fix. Applying them is a separate step, done by whoever asked for the review after checking each finding. A review does not authorize commits, pushes or merges.

Every review has three parts: **Bugs**, **Tests** and **Simpler**. All three block the merge, and the report has a section for each, even when it says there is nothing to flag. The same three parts apply to CodeRabbit, to independent reviews and to your own pre-PR pass.

Each finding is tagged:

- **Must fix**: a bug, or a break of a rule in `AGENTS.md` or this checklist. Items below marked must fix always report at this severity.
- **Recommended**: a judgment call the author can accept, change or decline with a reason. A Simpler finding that the reviewer cannot prove is still raised and still blocks until it is fixed or the PR says why it stays.

## Before reading the diff

- [ ] Verify the goal: read the PR's Intent and linked issue, state the goal in one line, and check every requested outcome against the diff. Flag missing outcomes, claims the diff does not deliver and unasked additions.
- [ ] Diff against the branch the PR targets, including uncommitted changes. A stacked PR reviews against its parent branch, not `main`.
- [ ] Read the intended behavior, `AGENTS.md` and [follow-conventions](../follow-conventions/SKILL.md). For `web/`, also read [write-front-end](../write-front-end/SKILL.md); for a cleanup or refactor, [deslop](../deslop/SKILL.md).
- [ ] If the tree mixes work from another branch, drop changes the base already has, unless the drift is deliberate here.

## Bugs

Correctness, races, stale caches, leaks and broken rules.

- [ ] Trace each changed path from input to observable result, including empty input, invalid input, failures, cancellation and recovery. Check permissions at the write boundary and keep useful error feedback.
- [ ] Check derived caches read by several processes (must fix): a correction or deletion resolves against the persisted records, not one process's memory. Example: the Oracle's `oracle.db` is read by the server and its search workers; if a worker kept a deleted or corrected note in its own memory, another process's search would still return it, so each query catches up from the saved event log and cursors.
- [ ] Check Pnyx's boundaries (must fix): only `pnyx-axi` writes Hydra state; the event log stays append-only; the reducer stays pure and deterministic; the rows beside the `events` table and Oracle indexes stay derived from events. Hooks stay fast and exit 0, never wait on the network, and print only the session-start summary. Integrations use their own supported read and reply interfaces.
- [ ] Check the [provider boundaries](../follow-conventions/SKILL.md#provider-boundaries) (must fix): usage parsing stays in each provider adapter; server and UI consume the shared interface and neutral shape, with no provider branches or duplicate counting.
- [ ] Use static imports. A dynamic `import()` requires a comment explaining its real need, such as a module that must load lazily.
- [ ] Check types and function contracts. Functions take one destructured object parameter, except no-argument functions and external API contracts (must fix). TypeScript stays erasable. An `any`, a cast or a non-null assertion that hides an unchecked value is must fix; a narrowing TypeScript cannot infer, with a short reason, is fine.
- [ ] Name a value with meaning beyond its literal (a timeout, a limit, a retry count) as a constant. Two sites repeating the same value without a shared constant is must fix.
- [ ] Check errors stay visible. A caught and dropped error with no reason given and no log or user feedback is must fix. A failure the user should see keeps its message through the CLI, server and page.
- [ ] Check timers, watchers, locks and subprocesses for cleanup on failure and shutdown. Keep ordering, retry limits and session ownership across asynchronous work.
- [ ] Reject unbounded waits, including `for (;;)` and `while (true)` polling without a deadline or attempt limit. Bad: `while (true) { if (await ready()) break }`. Good: `await waitFor({ ready, timeoutMs: 5000 })`, where timeout fails with the last observed state.
- [ ] For UI changes, check loading, empty and error states, keyboard access and the existing UI primitives. Use Hydra, Oracle and inscribe consistently.
- [ ] Flag every change under `.github/workflows`. A `pull_request_target` or `workflow_run` workflow must never check out, build or run the PR's code, for example a checkout of `github.event.pull_request.head.sha` or `head.ref`, or scripts from the PR, and must keep read-only permissions and use no secrets except the generated `GITHUB_TOKEN` for trusted code (must fix).
- [ ] Check docs, CLI help and hints describe the resulting behavior, in the same change (must fix).
- [ ] Review comments and prose using `deslop`. Keep a comment only for a constraint or non-obvious reason; remove narration and stale claims (must fix). Keep each prose paragraph on one source line.
- [ ] Run `pnpm verify` for the branch's checks. The lint fixer cannot settle unused variables or lines over 100 characters; report those. Respect any explicit test hold and report skipped checks as pending.

## Tests

Each test fails when the behaviour it covers breaks, and nothing user-facing is uncovered. [audit-tests](../audit-tests/SKILL.md) holds the full checklist; this part reads its result.

- [ ] Check that the change brings tests for each new or changed behaviour, in the layout of [Testing](../../../docs/testing.md), and that a bug fix has a test that reproduces the bug. A behaviour change with no such test is must fix; a behaviour-preserving refactor needs none, and its existing tests should still pass; [audit-tests](../audit-tests/SKILL.md) judges their quality.
- [ ] Match changed behavior to tests using [audit-tests](../audit-tests/SKILL.md). Read the assertions; a test name alone proves nothing. Tests assert user-visible behavior through public APIs, keep logic out of the expected values, and use real dependencies, faking only third-party services, AI providers and the network. A bug fix ships a test that fails with only the fix reverted (must fix).
- [ ] In tests, use IDs returned by setup or the operation under test. Bad: `taskShow({ id: 'task-1' })` after creating a task. Good: `taskShow({ id: created.id })`. Fixed IDs belong only in synthetic input whose identity is the contract.
- [ ] Do not match exact event sequence numbers read in separate operations: another writer can append between reads. Bad: `assert.equal(reply.seq, previouslyRead.seq + 1)`. Good: find the reply by its returned ID in one event snapshot, then assert its payload and causal link.

## Simpler

Ask of every changed line: is this the clearest way to get the result? Clear beats short. Fewer lines is not the goal; the test is whether a new reader follows the code on first read, and three plain named steps beat one chained line. Each finding names the replacement and what keeps working. These are the findings:

- [ ] It copies something that already exists. Search before accepting a new helper, component or type, and name the file and line to reuse.
- [ ] It is dead: an option, flag or branch nothing uses, a wrapper with one caller, an arm an earlier guard handled, a check on an already narrowed value, a fallback for a value that is always present, an unused export, a reference to a removed feature, debug output or a TODO marker. Search for them; don't guess.
- [ ] The same rule or state is kept in two places. Two flags or caches holding the same fact drift apart; keep one owner for each fact and one place for each shared decision.
- [ ] It is a hand-written version of something the stack already provides (the platform, Node, a dependency already installed, an existing UI primitive).
- [ ] It is hard to follow: it needs a comment to say what it does, or it is a packed one-liner, a long call chain, a clever trick or a nested condition. New and changed code reads as plain named steps, with no conditional spread (`...(x ? { a } : {})`), no logical assignment picking a value (`??=`, `||=`, `&&=`), no `||` or `??` default whose case the names don't make obvious, no bare `void` on a promise, no `.then` chain and no `for (;;)` or `while (true)` wait. Existing uses are not rewritten unless the change touches them.
- [ ] Code is placed badly, using [follow-conventions](../follow-conventions/SKILL.md#files-and-concerns): unrelated concerns piling into one file, a split that scatters closely related code, or a file that only wraps another. Keep feature code in its feature folder and avoid speculative abstractions and dependencies.

A "looks off" item the reviewer cannot prove still blocks. The fixer either fixes it or writes in the PR why it stays.

## Reporting

Report Bugs, Tests and Simpler as three sections. List findings in each by importance, must fix first, each with its tag, file and line, the failing behavior or broken rule, and a suggested fix. Keep observations the author should decide apart from findings to apply. Report suites plainly: a red suite is red, with the failing lines. Every must-fix finding is resolved, and each declined recommendation gets a reason. Once complete, tick **Ran `review-code`** in the PR and describe what you fixed (or say no findings).

When asked to open or update a PR for a branch this review has not covered, say so and offer to run it first.

For an agent: perform the checklist yourself when assigned the review; do not merely tell the developer to do it. Report findings before editing when asked only to inspect.
