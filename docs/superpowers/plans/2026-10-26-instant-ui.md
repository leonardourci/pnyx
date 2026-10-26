# Instant UI implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Display actions immediately and reconcile daemon outcomes without losing scoped work.

**Architecture:** Project explicit pending intents over confirmed resource state. Keep transport requests separate from resource lifetime; extend the existing projections and daemon idempotency contracts.

**Tech Stack:** TypeScript, React, existing WebSocket protocol, Node test runner.

**Spec:** Stored Pnyx report `report-84a5e5c4-ui-waits-v1` on task `task-84a5e5c4-7827-4586-b1ff-5b3987c51cc9` (read through `pnyx-axi task report`).

## Global constraints

- One PR per phase, each branch starts from fetched main; owner merges.
- Isolated homes and random ports; no live daemon on 4747.
- Preserve confirmations for deletion, project sharing and permissions.
- Keep daemon revisions and sequence authoritative; no pretend events.
- Until task-8990dcc2 lands, draft PRs without a verification marker; leave its three failing tests alone.
- Start phase 4 only after task-24977981 lands.

## Review focus

- Receipt before event must not reverse the preview.
- Refusal after newer server changes must preserve unrelated work.
- Disconnect must retain an unknown outcome without replaying unsafe effects.
- Dependencies must not survive a refused prerequisite.
- Resource scope must isolate installations and Hydras across component remounts.

### Phase 1: Shared pending intents

Files: new `web/src/hydra/pending-intents.ts`, `pending-state.ts`, shared UI status primitive; modify `connection.ts`, `app.tsx`; add `test/pending-intents.test.ts`.

Interfaces: generic scoped resource with confirmed base, intent snapshots, enqueue, sending, accept, refuse, unknown and confirm transitions; Hydra edit adapter consumes existing `optimisticState` and stable event IDs.

- [ ] Write tests for projection before acknowledgement, scope/remount reuse, receipt/event order, refusal with newer server changes, independent rapid writes, invalid dependents, structured errors and unknown reconciliation.
- [ ] Run focused tests and observe expected missing-implementation failure.
- [ ] Implement resource and integrate existing edit families, preserving revision serialization and event identity. Expose shared pending/unconfirmed presentation.
- [ ] Run focused tests, lint and build; exercise held acknowledgements in an isolated browser fixture.
- [ ] Review branch, fix findings, commit by concern, rebase on fetched main and push. Run allowed verification, open draft PR and link task.

### Phase 2: Instant Hydra navigation and creation

Files: connection/navigation, Hydra picker, server scoped transport/mount, creation CLI/core identity metadata, related server/browser tests.

- [ ] Build single-WebSocket explicit scope routing and target selection independent of old requests.
- [ ] Render cached/uncached/provisional targets immediately; promote canonical IDs without reload and retain drafts.
- [ ] Persist creation-attempt identity; contain saved-but-not-mounted failures; warm catalogs in background.
- [ ] Verify A→B→C/Back with held reads and writes, create identity promotion and mount failure; review and open its own PR from updated main.

### Phase 3: Reversible action adapters

Files: task creation, column/card editors, agent settings, projects, dispatch/Oracle preference resources.

- [ ] Add tests before each adapter; implement temporary task IDs/dependencies, immediate focus/closing, shared settings/project overlays.
- [ ] Verify concurrent refusal, sharing/deletion confirmation and canonical path/ID promotion; review and open its own PR.

### Phase 4: Delivery and reads (after compact lands)

Files: existing message queue/composer/chat, questions/permissions/stop, image uploads and retained read caches.

- [ ] Preserve stable outbox identity and delivery_unknown while migrating pending feedback.
- [ ] Add pending answers/permissions/stop/uploads and scoped retained cancellable reads with visible failures.
- [ ] Verify expired requests, restored drafts/comments, ambiguous delivery without duplicate effects; review and open its own PR.

### Phase 5: Context rule and acceptance

Files: `.agents/skills/write-front-end/SKILL.md`, integration/browser acceptance scenarios.

- [ ] Add the report’s exact front-end rule.
- [ ] Complete report acceptance coverage including long-history rendering and duplicate reads; profile before broader rendering changes.
- [ ] Run repository-required checks when prerequisite gates permit; review and open its own PR.
