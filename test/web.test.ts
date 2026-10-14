import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideMove, decidePush, decideReply, decideUndo, decideView, type Decision } from "../src/core/decide.ts";
import { emptyBoard, reduce } from "../src/core/reducer.ts";
import { BoardError, type BoardEvent, type BoardState } from "../src/core/model.ts";
import { patchView, viewFor } from "../src/core/view.ts";
import { columnsFor, filterCards, safeLink, slashPrefix, visibleParent } from "../web/src/board/view.ts";
import { withWriter } from "../src/store/board-store.ts";
import { readThread, recordEntries } from "../src/thread/read.ts";
const meta = { at: "2026-10-13T10:00:00Z", actor: "test" };
const event = (d: Decision): BoardEvent => { assert.ok("event" in d); return d.event; };
const push = (state: BoardState, key: string, fields: unknown) => reduce(state, event(decidePush(state, key, fields, meta)));

test("preferences replay deterministically, guard revisions, and undo removes map overrides", () => {
  const initial = push(emptyBoard(), "a", { title: "A" });
  const edit = event(decideView(initial, { columnWidths: { review: 400 }, cardTraceOverrides: { c1: { tools: true } } }, { ...meta, ifRevision: 0, id: "view-1" }));
  const state = reduce(initial, edit);
  assert.equal(initial.view, undefined);
  assert.equal(state.viewRevision, 1);
  assert.equal(viewFor(state).columnWidths.review, 400);
  assert.deepEqual(reduce(initial, edit), state);
  assert.deepEqual(decideView(state, {}, { ...meta, id: "view-1", ifRevision: 0 }), { skipped: "duplicate" });
  assert.throws(() => decideView(state, { fontSize: 18 }, { ...meta, ifRevision: 0 }), /changed/);
  const undone = reduce(state, event(decideUndo(state, edit, { ...meta, ifRevision: 1 })));
  assert.deepEqual(viewFor(undone), viewFor(initial));
  assert.throws(() => patchView(state, { fontSize: 100 }), BoardError);
  assert.throws(() => patchView(state, JSON.parse("{\"columnWidths\":{\"__proto__\":300}}")), BoardError);
});

test("custom columns accept manual placement and cannot strand existing cards", () => {
  let state = push(emptyBoard(), "a", { attention: [{ kind: "question", key: "q", blocking: true }] });
  state = reduce(state, event(decideView(state, { customColumns: [{ id: "custom:later", title: "Later" }] }, meta)));
  assert.equal(columnsFor(state).at(-1)?.title, "Later");
  assert.equal(patchView(emptyBoard(), { columnWidths: { "custom:one": 400 }, customColumns: [{ id: "custom:one", title: "One" }] }).columnWidths["custom:one"], 400);
  state = reduce(state, event(decideMove(state, "a", "custom:later", meta)));
  assert.equal(state.cards.c1!.column, "custom:later");
  assert.throws(() => patchView(state, { customColumns: [] }), /contains cards/);
  assert.throws(() => decideMove(state, "a", "custom:missing", meta), /unknown/);
  const toAuto = event(decideMove(state, "a", null, meta));
  state = reduce(state, toAuto);
  assert.equal(state.cards.c1!.column, "needs_you");
  assert.equal(state.cards.c1!.attention.length, 1);
  state = reduce(state, event(decideView(state, { customColumns: [] }, meta)));
  assert.throws(() => decideUndo(state, toAuto, meta), /unknown custom column/);
});

test("filters do not expose excluded parent details, and links/slashes stay literal", () => {
  let state = push(emptyBoard(), "parent", { title: "Private parent", workspace: "A" });
  state = push(state, "child", { title: "Searchable child", workspace: "B", parent: "parent", tags: ["ui"] });
  const visible = filterCards(state, "B", "ui", "searchable");
  assert.equal(visible.length, 1);
  assert.equal(visibleParent(visible[0]!, visible), undefined);
  assert.equal(safeLink({ kind: "url", url: "javascript:alert(1)" }), undefined);
  assert.equal(slashPrefix("/plan", 5), "/plan");
  assert.equal(slashPrefix("open /path", 10), null);
  assert.equal(slashPrefix("/tmp/file", 9), null);
});

test("thread reader ignores partial records, pages old messages, separates traces and reports unavailable capabilities", () => {
  const home = mkdtempSync(join(tmpdir(), "pnyx-thread-")); process.env.PNYX_HOME = home;
  const path = join(home, "session.jsonl");
  const records = Array.from({ length: 90 }, (_, i) => JSON.stringify({ type: "assistant", message: { content: `message ${i}` } }));
  writeFileSync(path, records.join("\n") + "\n{\"partial\":");
  const state = push(emptyBoard(), "a", { agent: { provider: "claude", sessionId: "fixture", transcriptPath: path } });
  const page = readThread("default", state, state.cards.c1!, []);
  assert.equal(page.entries.length, 60); assert.equal(page.entries.at(-1)?.text, "message 89"); assert.ok(page.older);
  const older = readThread("default", state, state.cards.c1!, [], page.older);
  assert.equal(older.entries.length, 30); assert.equal(older.entries[0]?.text, "message 0"); assert.equal(older.older, undefined);
  assert.equal(page.route, false); assert.equal(page.watching, "unknown");
  const entries = recordEntries({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "thinking" }, { type: "tool_use", input: "sk-abcdefghijklmnop123456789" }] } }, 0);
  assert.deepEqual(entries.map(e => e.kind), ["message", "thinking", "tool"]); assert.equal(entries[2]?.text, "[redacted]");
  assert.deepEqual(recordEntries({ type: "user", isMeta: true, message: { content: "injected" } }, 0), []);
});


test("long transcript messages and reply history page without losing text or duplicating entries", () => {
  const home = mkdtempSync(join(tmpdir(), "pnyx-thread-pages-")); process.env.PNYX_HOME = home;
  const path = join(home, "session.jsonl"), longText = "abcdefghij".repeat(7000);
  writeFileSync(path, JSON.stringify({ type: "assistant", timestamp: "2026-10-12T10:00:00Z", message: { content: longText } }) + "\n");
  const state = withWriter("default", w => {
    w.append(event(decidePush(w.state, "a", { agent: { provider: "claude", sessionId: "fixture", transcriptPath: path } }, meta)));
    for (let i = 0; i < 90; i++) w.append(event(decideReply(w.state, "a", { reply: `r${i}`, state: "queued", route: "fixture", text: `reply ${i}` }, meta)));
    return w.state;
  });
  let cursor: string | undefined;
  const pages: ReturnType<typeof readThread>["entries"][] = [];
  do {
    const page = readThread("default", state, state.cards.c1!, [], cursor);
    assert.ok(page.entries.length <= 60);
    pages.unshift(page.entries); cursor = page.older;
    assert.ok(pages.length < 10, "pagination terminates");
  } while (cursor);
  const entries = pages.flat();
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
  assert.equal(entries.filter(e => e.role.startsWith("assistant")).map(e => e.text).join(""), longText);
  assert.equal(entries.filter(e => e.role === "You").length, 90);
  const later = withWriter("default", w => { w.append(event(decideReply(w.state, "a", { reply: "r90", state: "queued", route: "fixture", text: "reply 90" }, meta))); return w.state; });
  assert.equal(readThread("default", later, later.cards.c1!, []).entries.at(-1)?.text, "reply 90");
});
