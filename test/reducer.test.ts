import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardEvent, Card } from "../src/core/model.ts";
import { columnFor, emptyBoard, reduce, replay } from "../src/core/reducer.ts";
import { assertGolden, readStream } from "./streams.ts";

for (const name of ["lifecycle", "duplicates", "pinned-attention", "undo"]) {
  test(`golden replay: ${name}`, () => {
    assertGolden(name, replay(emptyBoard(), readStream(name)));
  });
}

test("lifecycle: open pull request is review, all merged is done, outcome places the child", () => {
  const events = readStream("lifecycle");
  const at = (seq: number) => replay(emptyBoard(), events.slice(0, seq));
  assert.equal(at(1).cards.c1!.column, "workers_on_it");
  assert.equal(at(3).cards.c1!.column, "review");
  // One of two pull requests merged: still review.
  assert.equal(at(5).cards.c1!.column, "review");
  assert.equal(at(6).cards.c1!.column, "done");
  const end = at(events.length);
  assert.equal(end.cards.c2!.parentId, "c1");
  assert.equal(end.cards.c2!.column, "done");
  // A non-PR link does not move a done card.
  assert.equal(end.cards.c1!.column, "done");
});

test("duplicates and out-of-order observations are ignored", () => {
  const state = replay(emptyBoard(), readStream("duplicates"));
  const card = state.cards.c1!;
  assert.equal(state.seq, 9);
  assert.equal(card.title, "Refactor store layer");
  assert.equal(card.activity, "working");
  assert.equal(card.links[0]!.state, "merged");
  assert.equal(card.column, "done");
  assert.equal(state.eventIds["hook-0001"], 1);
  assert.equal(state.eventIds["hook-late"], undefined);
  // Applied: hook-0001, hook-0002, evt_7, hook-0005.
  assert.equal(card.revision, 4);
});

test("a pinned card keeps its column and shows new attention", () => {
  const state = replay(emptyBoard(), readStream("pinned-attention"));
  const card = state.cards.c1!;
  assert.equal(card.column, "review");
  assert.equal(card.manualColumn, "review");
  assert.deepEqual(card.attention.map((a) => a.kind), ["permission_needed"]);

  const auto: BoardEvent = {
    v: 1,
    seq: 4,
    id: "evt_4",
    at: "2026-10-13T13:04:00Z",
    actor: "cli",
    cardId: "c1",
    type: "card.moved",
    data: { before: "review", after: null },
  };
  assert.equal(reduce(state, auto).cards.c1!.column, "needs_you");
});

test("undo events restore the card and record what they reversed", () => {
  const state = replay(emptyBoard(), readStream("undo"));
  const card = state.cards.c1!;
  assert.equal(card.manualColumn, undefined);
  assert.deepEqual(card.links, []);
  assert.equal(card.outcome, undefined);
  assert.equal(card.column, "workers_on_it");
  assert.deepEqual(state.undone, { evt_2: "evt_3", evt_4: "evt_5", evt_6: "evt_7" });
});

test("replay is pure and deterministic", () => {
  const events = readStream("lifecycle");
  const start = emptyBoard();
  const frozen = structuredClone(start);
  const once = replay(start, events);
  assert.deepEqual(start, frozen);
  assert.deepEqual(replay(replay(start, events.slice(0, 4)), events.slice(4)), once);
  assert.deepEqual(replay(emptyBoard(), events), once);
});

test("a parent change that would make a cycle is ignored", () => {
  const events = readStream("lifecycle");
  const cycle: BoardEvent = {
    v: 1,
    seq: 9,
    id: "evt_9",
    at: "2026-10-13T10:09:00Z",
    actor: "cli",
    cardId: "c1",
    type: "card.pushed",
    data: { key: "claude:host-a:sess-1", parentId: "c2" },
  };
  assert.equal(replay(emptyBoard(), [...events, cycle]).cards.c1!.parentId, undefined);
});

function card(overrides: Partial<Card>): Card {
  return {
    id: "c1",
    key: "k",
    title: "t",
    workspace: "work",
    tags: [],
    attention: [],
    links: [],
    sourceRefs: [],
    column: "workers_on_it",
    revision: 1,
    createdSeq: 1,
    updatedSeq: 1,
    updatedAt: "2026-10-13T00:00:00Z",
    ...overrides,
  };
}

const pr = (state?: "open" | "merged" | "closed") => ({ kind: "github_pr" as const, url: `https://github.com/o/r/pull/${state}`, ...(state ? { state } : {}) });
const blocking = { kind: "reply_needed", key: "q1", blocking: true };
const note = { kind: "check_this", key: "n1", blocking: false };

test("column rules follow the settled precedence", () => {
  const cases: [string, Partial<Card>, string][] = [
    ["ongoing work", {}, "workers_on_it"],
    ["manual pin beats everything", { manualColumn: "done", attention: [blocking], links: [pr("open")] }, "done"],
    ["blocking request beats an open pull request", { attention: [blocking], links: [pr("open")] }, "needs_you"],
    ["open pull request", { links: [pr("open")] }, "review"],
    ["any open pull request means review", { links: [pr("merged"), pr("open")] }, "review"],
    ["all merged means done", { links: [pr("merged"), pr("merged")] }, "done"],
    ["merged plus unchecked is not done", { links: [pr("merged"), pr()] }, "workers_on_it"],
    ["closed unmerged needs you", { links: [pr("merged"), pr("closed")] }, "needs_you"],
    ["open pull request beats non-blocking attention", { attention: [note], links: [pr("open")] }, "review"],
    ["non-blocking attention", { attention: [note] }, "needs_you"],
    ["done outcome", { outcome: { state: "done" } }, "done"],
    ["cancelled outcome", { outcome: { state: "cancelled" } }, "done"],
    ["failed outcome", { outcome: { state: "failed" } }, "needs_you"],
    ["non-PR links do not place", { links: [{ kind: "linear", url: "https://linear.app/x" }] }, "workers_on_it"],
  ];
  for (const [name, overrides, expected] of cases) assert.equal(columnFor(card(overrides)), expected, name);
});
