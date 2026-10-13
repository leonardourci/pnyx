import assert from "node:assert/strict";
import { test } from "node:test";
import { decideLink, decideMove, decidePush, decideUndo, parseLink, type Decision, type Meta } from "../src/core/decide.ts";
import { BoardError, type BoardEvent, type BoardState } from "../src/core/model.ts";
import { emptyBoard, reduce } from "../src/core/reducer.ts";

const meta: Meta = { at: "2026-10-13T12:00:00Z", actor: "test" };

function apply(state: BoardState, decision: Decision): BoardState {
  assert.ok("event" in decision, `expected an event, got ${JSON.stringify(decision)}`);
  return reduce(state, decision.event);
}

function eventOf(decision: Decision): BoardEvent {
  assert.ok("event" in decision);
  return decision.event;
}

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof BoardError && error.code === code);

const source = (observedAt: string, generation = 1) => ({ adapter: "claude", objectId: "s1", generation, observedAt });

test("push upserts by key and repeats are no-ops", () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), "k1", { title: "One", source: source("2026-10-13T10:00:00Z") }, meta));
  assert.equal(state.keys.k1, "c1");
  assert.deepEqual(decidePush(state, "k1", { title: "One", source: source("2026-10-13T10:00:00Z") }, meta), { skipped: "unchanged" });
  state = apply(state, decidePush(state, "k1", { title: "One, renamed" }, meta));
  assert.equal(Object.keys(state.cards).length, 1);
  assert.equal(state.cards.c1!.title, "One, renamed");
});

test("push skips a repeated event id and an older observation", () => {
  const state = apply(emptyBoard(), decidePush(emptyBoard(), "k1", { source: source("2026-10-13T10:00:00Z", 2) }, { ...meta, id: "hook-1" }));
  assert.deepEqual(decidePush(state, "k1", { title: "x" }, { ...meta, id: "hook-1" }), { skipped: "duplicate" });
  assert.deepEqual(decidePush(state, "k1", { source: source("2026-10-13T09:00:00Z", 2) }, meta), { skipped: "stale" });
  assert.deepEqual(decidePush(state, "k1", { source: source("2026-10-13T11:00:00Z", 1) }, meta), { skipped: "stale" });
});

test("push validates its input", () => {
  rejects(() => decidePush(emptyBoard(), "k1", { titel: "typo" }, meta), "VALIDATION_ERROR");
  rejects(() => decidePush(emptyBoard(), "k1", { tags: "a" }, meta), "VALIDATION_ERROR");
  rejects(() => decidePush(emptyBoard(), "k1", { attention: [{ kind: "q" }] }, meta), "VALIDATION_ERROR");
  rejects(() => decidePush(emptyBoard(), "k1", { parent: "missing" }, meta), "NOT_FOUND");
  rejects(() => decidePush(emptyBoard(), "", {}, meta), "VALIDATION_ERROR");
});

test("push resolves the parent by key and rejects cycles", () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), "parent", {}, meta));
  state = apply(state, decidePush(state, "child", { parent: "parent" }, meta));
  assert.equal(state.cards.c2!.parentId, "c1");
  rejects(() => decidePush(state, "parent", { parent: "child" }, meta), "VALIDATION_ERROR");
  state = apply(state, decidePush(state, "child", { parent: null }, meta));
  assert.equal(state.cards.c2!.parentId, undefined);
});

test("parseLink fills GitHub pull request details and validates", () => {
  assert.deepEqual(parseLink({ url: "https://github.com/o/r/pull/12", state: "open" }), {
    kind: "github_pr",
    url: "https://github.com/o/r/pull/12",
    number: 12,
    state: "open",
  });
  assert.equal(parseLink({ url: "https://example.com/doc" }).kind, "url");
  rejects(() => parseLink({ url: "javascript:alert(1)" }), "VALIDATION_ERROR");
  rejects(() => parseLink({ url: "https://github.com/o/r/pull/1", state: "draft" }), "VALIDATION_ERROR");
});

test("undo reverses a move unless the card changed since", () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), "k1", {}, meta));
  const move = eventOf(decideMove(state, "c1", "review", meta));
  state = reduce(state, move);
  const undo = eventOf(decideUndo(state, move, meta));
  assert.equal(undo.undoes, move.id);
  assert.equal(reduce(state, undo).cards.c1!.manualColumn, undefined);

  const later = reduce(state, eventOf(decideMove(state, "c1", "done", meta)));
  rejects(() => decideUndo(later, move, meta), "CONFLICT");
  rejects(() => decideUndo(state, move, meta, 99), "CONFLICT");
  const undone = reduce(state, undo);
  rejects(() => decideUndo(undone, move, meta), "CONFLICT");
});

test("undo reverses a link update to its earlier value", () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), "k1", {}, meta));
  const url = "https://github.com/o/r/pull/3";
  state = apply(state, decideLink(state, "c1", url, parseLink({ url, state: "open" }), meta));
  const merged = eventOf(decideLink(state, "c1", url, { kind: "github_pr", url, state: "merged" }, meta));
  state = reduce(state, merged);
  assert.equal(state.cards.c1!.column, "done");
  state = reduce(state, eventOf(decideUndo(state, merged, meta)));
  assert.equal(state.cards.c1!.links[0]!.state, "open");
  assert.equal(state.cards.c1!.column, "review");
});

test("pushes cannot be undone", () => {
  const push = eventOf(decidePush(emptyBoard(), "k1", {}, meta));
  rejects(() => decideUndo(reduce(emptyBoard(), push), push, meta), "VALIDATION_ERROR");
});
