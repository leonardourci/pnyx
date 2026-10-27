---
name: audit-tests
description: Audit Pnyx tests for the real behavior a change promises, missing regression coverage, brittle assertions and safe isolation.
---

# Audit tests

Use the changed behavior as the scope unless a wider area was requested. Read `test/README.md` for the test harness.

- [ ] Inventory behavior as “when X happens, Y results”. Include success, refusal, invalid or empty input, failure, recovery and restart when relevant. For Pnyx, cover permissions, event persistence and replay, worker lifecycle and reply delivery where touched.
- [ ] Map each behavior to a test and its observable assertion: CLI output and exit status, persisted events and rebuilt state, server responses, delivered replies or what the user sees in the browser.
- [ ] Apply the flip test: mentally invert a condition, omit an event or delivery, or return the wrong result. The relevant assertion must fail. A regression test must fail with the fix reverted.
- [ ] Reject tests that grep, regex-match or snapshot source text. Reading implementation files to assert spelling, helper names or code shape does not exercise behavior. Invoke the real function, CLI, server or page instead. Snapshots of outputs are useful only when the output itself is the contract and a behavioral break changes the assertion.
- [ ] Remove brittleness from assertions on incidental copy, log order, private helper calls or timing. Wait for an observable condition with a bounded wait; do not use fixed sleeps or retries to hide a race.
- [ ] Register completion observers before triggering work. For absence, drain the named operation; for domain deadlines, control time and assert just before and at the boundary. Force race phases with gates instead of repeated scheduling attempts or PID order.
- [ ] Keep process isolation and sequential tests within each file while environment and filesystem mocks are global. Restore mocks, close owned resources, and use pipe-controlled Chrome with a temporary profile instead of releasing a discovered port. Before merging tests, map and transfer every unique assertion; keep a real CLI, transport or restart smoke for each affected boundary.
- [ ] Reject unbounded waits, including `for (;;)` and `while (true)` polling without a deadline or attempt limit. Bad: `while (true) { if (await ready()) break }`. Good: `await waitFor({ ready, timeoutMs: 5000 })`, where timeout fails with the last observed state.
- [ ] Do not match exact event sequence numbers read in separate operations: another writer can append between reads. Bad: `assert.equal(reply.seq, previouslyRead.seq + 1)`. Good: find the reply by its returned ID in one event snapshot, then assert its payload and causal link.
- [ ] In tests, use IDs returned by setup or the operation under test. Bad: `taskShow({ id: 'task-1' })` after creating a task. Good: `taskShow({ id: created.id })`. Fixed IDs belong only in synthetic input whose identity is the contract.
- [ ] Pick the smallest level that proves the contract. Pure reducer, formatting and parsing rules fit unit tests. Wiring, permissions, persistence and lifecycle behavior need integration or scenarios through the real boundary. Use browser journeys for behavior that depends on the rendered page.
- [ ] Isolate every test with temporary `PNYX_HOME`, random ports and synthetic fixtures. Never access real user folders, tools, services or accounts. Fake external services at their boundary. Remove inherited worker identity in owner-CLI subprocesses.
- [ ] Check coverage is meaningful before adding more tests. Prefer one assertion that catches the bug to a new fixture framework or redundant cases that mirror implementation.
- [ ] Run focused tests while editing and the suites selected by `pnpm verify` before readiness. Respect explicit test holds; record pending suites and known failures without changing unrelated tests or claiming a pass.

Report a short behavior-to-test mapping, gaps and brittle tests, with the test and observable assertion needed for each gap. Record what ran, passed, failed or remains pending. Once complete, tick **Ran `audit-tests`** in the PR and describe what you fixed (or say no findings). The audit can be complete while a suite is pending; pending suites still prevent a verification marker.

For an agent: inspect assertions and exercise the behavior yourself. Do not substitute a source-text search or a list of test filenames for the audit.
