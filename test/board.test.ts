// End-to-end through the built pnyx-axi binary.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { boardDir, spoolWrite } from "../src/store/board-store.ts";

const BIN = join(import.meta.dirname, "..", "dist", "cli", "pnyx-axi.js");

function board() {
  // Tests never touch the real ~/.pnyx.
  const home = mkdtempSync(join(tmpdir(), "pnyx-board-"));
  const env = { ...process.env, PNYX_HOME: home };
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
  const fails = (args: string[], status: number, code: string) =>
    assert.throws(() => run(...args), (error: { status: number; stdout: string }) => {
      assert.equal(error.status, status);
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, "m"));
      return true;
    });
  const card = (json: object) => {
    const file = join(home, `card-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify(json));
    return file;
  };
  return { home, env, run, fails, card };
}

test("push is an idempotent upsert by key", () => {
  const { run, card } = board();
  const file = card({ title: "Ship login", workspace: "work", tags: ["auth"] });
  assert.match(run("push", "--key", "claude:s1", "--file", file), /^ {2}id: c1$/m);
  assert.match(run("push", "--key", "claude:s1", "--file", file), /^event: "none: unchanged"$/m);
  assert.match(run("push", "--key", "claude:s1", "--file", card({ title: "x" }), "--event-id", "e1"), /^ {2}seq: 2$/m);
  const retry = run("push", "--key", "claude:s1", "--file", card({ title: "y" }), "--event-id", "e1");
  assert.match(retry, /^ {2}seq: 2$/m);
  assert.match(retry, /^duplicate: /m);
  const out = run();
  assert.match(out, /^ {2}workers_on_it: 1$/m);
  assert.match(out, /^ {2}c1,x,workers_on_it,none$/m);
});

test("links, moves and outcomes place the card", () => {
  const { run, card } = board();
  run("push", "--key", "k", "--file", card({ title: "Task" }));
  run("link", "c1", "--url", "https://github.com/o/r/pull/7", "--state", "open");
  assert.match(run("card", "k"), /^ {2}column: review$/m);
  run("move", "c1", "needs-you");
  assert.match(run("card", "c1"), /^ {2}placement: manual$/m);
  run("link", "c1", "--url", "https://github.com/o/r/pull/7", "--state", "merged");
  assert.match(run("card", "c1"), /^ {2}column: needs_you$/m);
  run("move", "c1", "--auto");
  assert.match(run("card", "c1"), /^ {2}column: done$/m);
  run("outcome", "c1", "done", "--note", "shipped");
  assert.match(run("history", "--kind", "outcome"), /done: shipped/);
});

test("history pages newest first and filters", () => {
  const { run, card } = board();
  for (let i = 0; i < 5; i++) run("push", "--key", "k", "--file", card({ title: `t${i}` }));
  const first = run("history", "--limit", "2");
  assert.match(first, /^events\[2\]/m);
  assert.match(first, /^ {2}5,evt_5,/m);
  assert.match(first, /history --limit 2 --before 4/);
  const next = run("history", "--limit", "2", "--before", "4");
  assert.match(next, /^ {2}3,evt_3,/m);
  assert.match(run("history", "--kind", "moved"), /^events: "none: no matching events"$/m);
});

test("undo appends a reversing event and refuses a second undo", () => {
  const { run, card } = board();
  run("push", "--key", "k", "--file", card({}));
  run("move", "c1", "done");
  assert.match(run("undo", "evt_2"), /^ {2}seq: 3$/m);
  assert.match(run("card", "c1"), /^ {2}placement: auto$/m);
  assert.match(run("history", "--limit", "1"), /undo evt_2: done -> auto/);
});

test("every write takes --event-id and --if-revision", () => {
  const { run, fails, card } = board();
  run("push", "--key", "k", "--file", card({}), "--if-revision", "0");
  fails(["push", "--key", "k", "--file", card({ title: "x" }), "--if-revision", "0"], 1, "REVISION_CONFLICT");
  const url = "https://github.com/o/r/pull/7";
  assert.match(run("link", "c1", "--url", url, "--state", "open", "--event-id", "l1", "--if-revision", "1"), /^ {2}revision: 2$/m);
  run("outcome", "c1", "done", "--event-id", "o1");
  // A retried link reports what it got the first time, not a conflict.
  const retry = run("link", "c1", "--url", url, "--state", "open", "--event-id", "l1", "--if-revision", "1");
  assert.match(retry, /^ {2}seq: 2$/m);
  assert.match(retry, /^ {2}revision: 2$/m);
  assert.match(retry, /^duplicate: /m);
  fails(["outcome", "c1", "failed", "--if-revision", "1"], 1, "REVISION_CONFLICT");
  fails(["move", "c1", "done", "--if-revision", "1"], 1, "REVISION_CONFLICT");
  fails(["undo", "o1", "--if-revision", "1"], 1, "REVISION_CONFLICT");
});

test("undo reverses a manual push edit and refuses a merge", () => {
  const { run, fails, card } = board();
  run("push", "--key", "k", "--file", card({ title: "Before" }));
  run("push", "--key", "k", "--file", card({ title: "After" }));
  run("undo", "evt_2");
  assert.match(run("card", "c1"), /^ {2}title: Before$/m);
  fails(["undo", "evt_1"], 1, "NOT_UNDOABLE");
  run("link", "c1", "--url", "https://github.com/o/r/pull/7", "--state", "merged");
  fails(["undo", "evt_4"], 1, "NOT_UNDOABLE");
  assert.match(run("card", "c1"), /^ {2}column: done$/m);
});

test("errors are structured", () => {
  const { fails } = board();
  fails(["card", "c9"], 1, "NOT_FOUND");
  fails(["move", "c1"], 2, "VALIDATION_ERROR");
  fails(["outcome", "c1"], 2, "VALIDATION_ERROR");
  fails(["push", "--key", "k"], 2, "VALIDATION_ERROR");
  fails(["history", "--bogus"], 2, "VALIDATION_ERROR");
  fails(["undo", "evt_1"], 1, "NOT_FOUND");
});

test("a torn tail blocks writes until repair", () => {
  const { home, run, fails, card } = board();
  run("push", "--key", "k", "--file", card({ title: "a" }));
  appendFileSync(join(home, "boards", "default", "events.jsonl"), '{"v":1,"seq":2,"id":"ev');
  assert.match(run(), /torn tail/);
  fails(["move", "c1", "done"], 1, "TORN_TAIL");
  assert.match(run("repair"), /set aside 23 torn bytes/);
  assert.match(run("move", "c1", "done"), /^ {2}seq: 2$/m);
});

test("spooled hook events are ingested once, in order, by the next write", () => {
  const { env, run, card } = board();
  process.env.PNYX_HOME = env.PNYX_HOME;
  spoolWrite("default", { id: "hook-1", key: "codex:t1", at: "2026-10-13T10:00:00Z", actor: "hook", card: { title: "From hook" } });
  spoolWrite("default", { id: "hook-1", key: "codex:t1", at: "2026-10-13T10:00:01Z", card: { title: "Respooled" } });
  const spool = join(boardDir("default"), "spool");
  writeFileSync(join(spool, "999-bad.json"), "{nope");
  const out = run("push", "--key", "other", "--file", card({}));
  assert.match(out, /^ {2}ingested: 2$/m);
  assert.match(out, /^ {2}rejected: 1$/m);
  assert.match(run("card", "codex:t1"), /^ {2}title: From hook$/m);
  assert.deepEqual(readdirSync(spool), ["999-bad.json.rejected"]);
  assert.match(run("history"), /^events\[2\]/m);
});

test("concurrent writers get one contiguous sequence", async () => {
  const { env, run, card } = board();
  const exec = promisify(execFile);
  const file = card({});
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => exec(process.execPath, [BIN, "push", "--key", `k${i}`, "--file", file], { env })),
  );
  const log = readFileSync(join(env.PNYX_HOME, "boards", "default", "events.jsonl"), "utf8").trimEnd().split("\n");
  assert.deepEqual(log.map((l) => JSON.parse(l).seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(run(), /^ {2}workers_on_it: 8$/m);
  assert.equal(existsSync(join(env.PNYX_HOME, "boards", "default", "writer.lock")), false);
});
