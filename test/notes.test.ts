// Harvested notes: summaries, decisions and context that transcripts and linked
// pull requests already hold, folded into cards and search. Fixtures and a temp
// PNYX_HOME only; gh-axi is a fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transcriptNotes } from "../src/integrations/hooks/notes.ts";
import { transcriptMessages } from "../src/search/text.ts";
import { loadBoard, readEvents, spoolWrite } from "../src/store/board-store.ts";

const BIN = join(import.meta.dirname, "..", "dist", "cli", "pnyx-axi.js");
const FIXTURES = join(import.meta.dirname, "fixtures");
const CLAUDE = join(FIXTURES, "transcripts", "claude-notes.jsonl");
const CODEX = join(FIXTURES, "transcripts", "codex-notes.jsonl");
const GH_AXI = join(FIXTURES, "github", "gh-axi.sh");

const records = (path: string) => readFileSync(path, "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l) as unknown);

test("a Claude Code transcript yields its titles, compaction summaries and answered questions", () => {
  const notes = records(CLAUDE).flatMap(transcriptNotes);
  assert.deepEqual(
    notes.map(({ kind, source, text, at }) => ({ kind, source, text, ...(at ? { at } : {}) })),
    [
      { kind: "context", source: "claude-code", text: "Session title: Nightly invoice export" },
      { kind: "context", source: "claude-code", text: "Session title: Nightly invoice export" },
      { kind: "decision", source: "claude-code", text: "Which time window should the batch use?\nAnswer: 2am UTC", at: "2026-10-11T09:02:00.000Z" },
      {
        kind: "decision",
        source: "claude-code",
        text: "Keep the on-demand export?\nAnswer: No, batch only\nNotes: partners never used it",
        at: "2026-10-11T09:02:00.000Z",
      },
      {
        kind: "summary",
        source: "claude-code",
        text: "1. Primary Request and Intent: move the invoice export to a nightly batch at 2am UTC; the zebrafish pipeline stalled overnight.\n2. Pending: drop the on-demand export once partners confirm; the old cron job stays until the first nightly batch has run cleanly for a full week, then it goes along with its alerting rules.",
        at: "2026-10-11T10:00:01.000Z",
      },
      { kind: "context", source: "claude-code", text: "Session title: Invoice batch rollout" },
      { kind: "summary", source: "claude-code", text: "Invoice export moved to a nightly batch" },
    ],
  );
  // A repeated title names the same note; a declined question yields none.
  assert.equal(notes[0]!.ref, notes[1]!.ref);
  assert.equal(new Set(notes.map((n) => n.ref)).size, notes.length - 1);
  // The compaction summary is a note, not transcript text.
  assert.ok(!records(CLAUDE).flatMap(transcriptMessages).some((m) => m.text.includes("zebrafish")));
});

test("a Codex transcript yields its readable compaction summaries", () => {
  assert.deepEqual(
    records(CODEX).flatMap(transcriptNotes).map(({ kind, source, text, at }) => ({ kind, source, text, at })),
    [{ kind: "summary", source: "codex", text: "The ledger sync drifts because rounding happens before currency conversion.", at: "2026-10-12T11:00:00.000Z" }],
  );
});

function board() {
  // Tests never touch the real ~/.pnyx.
  const home = mkdtempSync(join(tmpdir(), "pnyx-notes-"));
  process.env.PNYX_HOME = home;
  const env = { ...process.env, PNYX_HOME: home, PNYX_GH_AXI: GH_AXI };
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const fails = (args: string[], code: string) =>
    assert.throws(() => run(...args), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, "m"));
      return true;
    });
  const push = (key: string, card: object) => {
    const file = join(home, "card.json");
    writeFileSync(file, JSON.stringify(card));
    run("push", "--key", key, "--file", file);
  };
  const transcript = (name: string, from: string) => {
    const path = join(home, name);
    copyFileSync(from, path);
    return path;
  };
  return { home, run, fails, push, transcript };
}

const noted = () => readEvents("default").filter((e) => e.type === "card.noted");

test("harvest folds transcript notes and pull requests into cards once", () => {
  const { run, fails, push, transcript } = board();
  push("claude:s1", { title: "Invoices", agent: { provider: "claude-code", sessionId: "s1", transcriptPath: transcript("s1.jsonl", CLAUDE) } });
  push("codex:x2", { title: "Ledger", agent: { provider: "codex", sessionId: "x2", transcriptPath: transcript("x2.jsonl", CODEX) } });
  run("link", "c1", "--url", "https://github.com/o/r/pull/42");
  run("link", "c1", "--url", "https://github.com/o/r/pull/7");
  assert.match(run("card", "c1"), /^ {2}summary: none$/m);

  const out = run("harvest");
  assert.match(out, /^ {2}notes: 8 new$/m);
  assert.match(out, /^ {2}pullRequests: 1$/m);
  assert.match(out, /^unread\[1\]: "https:\/\/github.com\/o\/r\/pull\/7"$/m);
  assert.match(run("harvest"), /^ {2}notes: "none: nothing new"$/m);
  assert.equal(noted().length, 8);
  assert.ok(noted().every((e) => e.actor === "harvest"));

  const card = run("card", "c1");
  assert.match(card, /^notes:\n {2}summary\[2\]\{at,source,text\}:$/m);
  assert.match(card, /^ {2}decisions\[2\]\{at,source,text\}:\n {4}"2026-10-11T09:02:00.000Z",claude-code,"Which time window/m);
  assert.match(card, /^ {2}context\[3\]\{at,source,text\}:$/m);
  assert.match(card, /github,"Pull request #42: Nightly invoice export\\n\\nMoves the invoice export to a 2am UTC batch\."$/m);
  assert.doesNotMatch(card, /pipelineevidenceword|templatemarkerword/);
  // Long text is cut by default and shown whole with --full.
  assert.match(card, /pnyx-axi card c1 --full/);
  const full = run("card", "c1", "--full");
  assert.match(full, /Pending: drop the on-demand export/);
  assert.doesNotMatch(full, /--full/);
  assert.match(run("card", "c2"), /^ {2}summary\[1\]\{at,source,text\}:\n {4}"2026-10-12T11:00:00.000Z",codex,The ledger sync drifts/m);
  assert.match(run("history", "--kind", "noted", "--card", "c2"), /summary from codex/);

  // A harvested note is a source observation.
  fails(["undo", noted()[0]!.id], "NOT_UNDOABLE");
  fails(["harvest", "--card", "nope"], "NOT_FOUND");
});

test("harvest reads only what a transcript gained, and a lost cursor appends nothing twice", () => {
  const { home, run, push } = board();
  const path = join(home, "s1.jsonl");
  writeFileSync(path, "");
  push("claude:s1", { agent: { provider: "claude-code", sessionId: "s1", transcriptPath: path } });
  assert.match(run("harvest"), /none: nothing new/);
  appendFileSync(path, readFileSync(CLAUDE, "utf8"));
  assert.match(run("harvest", "--card", "claude:s1"), /^ {2}notes: 6 new$/m);
  appendFileSync(path, `${JSON.stringify({ type: "custom-title", customTitle: "Renamed", sessionId: "s1" })}\n`);
  assert.match(run("harvest"), /^ {2}notes: 1 new$/m);
  writeFileSync(join(home, "boards", "default", "harvest.json"), "not json");
  assert.match(run("harvest"), /none: nothing new/);
  assert.equal(noted().length, 7);
});

test("a session that ends a turn is harvested when its hook event is ingested", () => {
  const { run, transcript } = board();
  const path = transcript("s9.jsonl", CLAUDE);
  const payload = { session_id: "s9", transcript_path: path, cwd: "/work" };
  spoolWrite("default", { v: 1, id: "h1", at: "2026-10-11T11:00:00.000Z", harness: "claude", event: "Stop", payload });
  writeFileSync(join(process.env.PNYX_HOME!, "other.json"), "{}");
  // Any write drains the spool first.
  assert.match(run("push", "--key", "other", "--file", join(process.env.PNYX_HOME!, "other.json")), /^ {2}notes: 6$/m);
  const { state } = loadBoard("default");
  assert.equal(state.cards[state.keys["claude:s9"]!]!.notes?.length, 6);
});

test("search finds notes and ranks them above the same words in a transcript", () => {
  const { home, run, push } = board();
  const raw = join(home, "raw.jsonl");
  const summary = join(home, "summary.jsonl");
  const text = "Zebrafish pipeline stalled overnight.";
  writeFileSync(raw, `${JSON.stringify({ type: "user", timestamp: "2026-10-11T09:00:00.000Z", message: { content: text } })}\n`);
  writeFileSync(summary, `${JSON.stringify({ type: "user", isCompactSummary: true, uuid: "z1", message: { content: text } })}\n`);
  push("claude:raw", { title: "First", agent: { provider: "claude-code", sessionId: "raw", transcriptPath: raw } });
  push("claude:sum", { title: "Second", agent: { provider: "claude-code", sessionId: "sum", transcriptPath: summary } });
  run("harvest");
  const cards = (out: string) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(cards(run("search", "zebrafish", "pipeline")), ["c2", "c1"]);
  assert.match(run("search", "zebrafish", "--kind", "note"), /^ {6}note,"[^"]+","\[Zebrafish\] pipeline stalled overnight\."$/m);
  assert.deepEqual(cards(run("search", "zebrafish", "--kind", "transcript")), ["c1"]);
  assert.match(run("search", "status"), /^ {2}note: 1$/m);
});
