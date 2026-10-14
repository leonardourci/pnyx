import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import { BoardError } from "../src/core/model.ts";
import { startServer, type RunningServer, type ServerMessage } from "../src/server/server.ts";
import { infoPath, localToken, socketPath } from "../src/server/state.ts";
import { boardDir, loadBoard, spoolDir, spoolWrite } from "../src/store/board-store.ts";

const BIN = join(import.meta.dirname, "..", "dist", "cli", "pnyx-axi.js");
const TIMEOUT_MS = 3000;

let server: RunningServer | undefined;

beforeEach(() => {
  // Every test gets its own home; nothing touches the real ~/.pnyx.
  process.env.PNYX_HOME = mkdtempSync(join(tmpdir(), "pnyx-server-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const cli = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: TIMEOUT_MS });

const hookEvent = (id: string, key: string, title: string) => ({ id, key, at: "2026-10-13T14:00:00Z", actor: "hook", card: { title } });

async function until<T>(check: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const seqIs = (seq: number, board = "default") => until(() => (loadBoard(board).state.seq === seq ? true : undefined), `seq ${seq}`);

async function sendToSocket(path: string, text: string): Promise<void> {
  const conn = connect(path);
  await once(conn, "connect");
  conn.end(text);
  await once(conn, "close");
}

async function tab(query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?token=${localToken()}${query.replace("?", "&")}`);
  const queue: ServerMessage[] = [];
  const waiting: ((m: ServerMessage) => void)[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  await once(ws, "open");
  return {
    ws,
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise<ServerMessage>((resolve, reject) => {
            waiting.push(resolve);
            setTimeout(() => reject(new Error("timed out waiting for a message")), TIMEOUT_MS).unref();
          }),
    command(id: string, name: string, args: string[]) {
      ws.send(JSON.stringify({ type: "command", id, name, args }));
    },
    // Nothing arrives within a short quiet period.
    async idle() {
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(queue, []);
    },
  };
}

function http(method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server!.port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function handshakeStatus(query: string, headers: Record<string, string> = {}): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws${query}`, { headers });
  const [, response] = await once(ws, "unexpected-response");
  return response.statusCode;
}

async function boardWithCard(board = "default") {
  server = await startServer({ board });
  await sendToSocket(server.socket!, JSON.stringify(hookEvent("hook-1", "a", "A")));
  await seqIs(1, board);
  return loadBoard(board).state.keys.a!;
}

test("serve runs until stop, and the summary reports it without starting it", async () => {
  const before = cli();
  assert.match(before, /^server: not running$/m);
  assert.match(before, /pnyx-axi serve/);
  assert.equal(existsSync(infoPath("default")), false);

  const child = spawn(process.execPath, [BIN, "serve"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const url = await until(() => /^url: "(http:\/\/127\.0\.0\.1:\d+)"$/m.exec(out)?.[1], "serve to start");
  await until(() => (existsSync(infoPath("default")) ? true : undefined), "server.json");
  assert.match(cli(), new RegExp(`^server: "running at ${url}"$`, "m"));
  assert.ok(existsSync(socketPath("default")));

  assert.match(cli("stop"), /^server: stopped$/m);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(out, /^server: stopped$/m);
  assert.equal(existsSync(infoPath("default")), false);
  assert.equal(existsSync(socketPath("default")), false);
  assert.match(cli(), /^server: not running$/m);
  assert.match(cli("stop"), /^server: "none: not running"$/m);
});

test("a second server for the same board is refused", async () => {
  server = await startServer({ board: "default" });
  await assert.rejects(startServer({ board: "default" }), (error) => error instanceof BoardError && error.code === "ALREADY_RUNNING");
});

test("hook events on the socket become cards and reach open tabs", async () => {
  server = await startServer({ board: "default" });
  const t = await tab();
  assert.deepEqual(await t.next(), { type: "snapshot", seq: 0, state: loadBoard("default").state });

  const event = JSON.stringify(hookEvent("hook-1", "session-a", "Fix the parser"));
  // A repeated event id is ingested once; a line that is not JSON is dropped.
  await sendToSocket(server.socket!, `${event}\nnot json\n${event}`);
  const message = await t.next();
  assert.equal(message.type, "event");
  assert.equal(message.type === "event" && message.event.seq, 1);
  assert.equal(message.type === "event" && message.event.id, "hook-1");
  await t.idle();
  const { state } = loadBoard("default");
  assert.equal(state.cards[state.keys["session-a"]!]!.title, "Fix the parser");
  assert.deepEqual(readdirSync(spoolDir(boardDir("default"))), []);
});

test("spooled hook events are drained on start and while running", async () => {
  spoolWrite("default", hookEvent("hook-1", "session-a", "Written while the server was down"));
  server = await startServer({ board: "default" });
  await seqIs(1);
  spoolWrite("default", hookEvent("hook-2", "session-b", "Spooled while it runs"));
  await seqIs(2);
  const { state } = loadBoard("default");
  assert.deepEqual(Object.keys(state.keys).sort(), ["session-a", "session-b"]);
  assert.deepEqual(readdirSync(spoolDir(boardDir("default"))), []);
});

test("a tab resumes from its cursor, gets CLI writes, and resyncs with a snapshot on a gap", async () => {
  server = await startServer({ board: "default" });
  await sendToSocket(server.socket!, `${JSON.stringify(hookEvent("hook-1", "a", "A"))}\n${JSON.stringify(hookEvent("hook-2", "b", "B"))}\n`);
  await seqIs(2);

  const behind = await tab("?after=1");
  const caughtUp = await behind.next();
  assert.equal(caughtUp.type === "event" && caughtUp.event.seq, 2);
  await behind.idle();

  const current = await tab("?after=2");
  await current.idle();

  // A cursor the server cannot continue from gets the whole board instead.
  const ahead = await tab("?after=99");
  const snapshot = await ahead.next();
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.type === "snapshot" && snapshot.seq, 2);

  // A tab that notices a gap itself asks for a snapshot.
  current.ws.send(JSON.stringify({ type: "resync" }));
  const resynced = await current.next();
  assert.equal(resynced.type === "snapshot" && resynced.seq, 2);

  // The CLI stays a writer of the same log; the server pushes what it appends.
  const cardId = loadBoard("default").state.keys.a!;
  cli("move", cardId, "review");
  const moved = await current.next();
  assert.equal(moved.type === "event" && moved.event.seq, 3);
  assert.equal(moved.type === "event" && moved.event.type, "card.moved");
});

test("a tab writes over its WebSocket and gets a receipt with its request id, recorded as web", async () => {
  const cardId = await boardWithCard();
  const t = await tab("?after=1");

  t.command("req-1", "move", [cardId, "review"]);
  const receipt = await t.next();
  assert.equal(receipt.type, "receipt");
  assert.equal(receipt.type === "receipt" && receipt.id, "req-1");
  assert.deepEqual(receipt.type === "receipt" && receipt.card, { id: cardId, column: "review", revision: 2 });
  const pushed = await t.next();
  assert.equal(pushed.type === "event" && pushed.event.type, "card.moved");
  assert.equal(pushed.type === "event" && pushed.event.actor, "web");

  t.command("req-2", "outcome", [cardId, "done", "--actor", "leo"]);
  assert.equal((await t.next()).type, "receipt");
  const outcome = await t.next();
  assert.equal(outcome.type === "event" && outcome.event.actor, "leo");
});

test("a bad command gets an error carrying its request id and writes nothing", async () => {
  const cardId = await boardWithCard();
  const t = await tab("?after=1");

  const cases: [string, string, unknown, string][] = [
    ["r1", "push", ["--key", "x", "--file", "/etc/hosts"], "NOT_FOUND"],
    ["r2", "move", "not a list", "VALIDATION_ERROR"],
    ["r3", "move", ["no-such-card", "review"], "NOT_FOUND"],
    ["r4", "move", [cardId, "review", "--board", "other"], "VALIDATION_ERROR"],
    ["r5", "move", [cardId, "review", "--board=other"], "VALIDATION_ERROR"],
  ];
  for (const [id, name, args, code] of cases) {
    t.ws.send(JSON.stringify({ type: "command", id, name, args }));
    const reply = await t.next();
    assert.equal(reply.type, "error");
    assert.equal(reply.type === "error" && reply.id, id);
    assert.equal(reply.type === "error" && reply.code, code, `${id}: ${reply.type === "error" && reply.error}`);
  }
  await t.idle();
  assert.equal(loadBoard("default").state.seq, 1);
  assert.equal(existsSync(boardDir("other")), false);
});

test("writes through the server always land on the server's own board", async () => {
  const cardId = await boardWithCard("work");
  const t = await tab("?after=1");
  t.command("req-1", "move", [cardId, "review"]);
  assert.equal((await t.next()).type, "receipt");
  await seqIs(2, "work");
  assert.equal(loadBoard("work").state.cards[cardId]!.column, "review");
  assert.equal(loadBoard("default").state.seq, 0);
});

test("the WebSocket handshake needs the token, an exact host and an exact origin", async () => {
  server = await startServer({ board: "default" });
  const token = `?token=${localToken()}`;
  assert.equal(await handshakeStatus(""), 401);
  assert.equal(await handshakeStatus("?token=wrong"), 401);
  assert.equal(await handshakeStatus(token, { origin: "http://evil.example" }), 403);
  assert.equal(await handshakeStatus(token, { origin: `http://127.0.0.1:${server.port}.evil.example` }), 403);
  assert.equal(await handshakeStatus(token, { host: `evil.example:${server.port}` }), 403);

  const ok = new WebSocket(`ws://127.0.0.1:${server.port}/ws${token}`, { headers: { origin: `http://localhost:${server.port}` } });
  await once(ok, "open");
  ok.close();
});

test("the board page carries the token only for its own host and origin; /health names the board", async () => {
  server = await startServer({ board: "default" });
  const meta = `<meta name="pnyx-token" content="${localToken()}" />`;

  for (const path of ["/", "/index.html", "/some/route"]) {
    const page = await http("GET", path, { origin: `http://127.0.0.1:${server.port}` });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(meta), path);
    assert.equal(page.headers["cache-control"], "no-store");
  }
  for (const headers of [{ host: `evil.example:${server.port}` }, { origin: "http://evil.example" }] as Record<string, string>[]) {
    const refused = await http("GET", "/", headers);
    assert.equal(refused.status, 403);
    assert.ok(!refused.text.includes(localToken()));
  }

  const health = await http("GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text), { board: "default", pid: process.pid });
  assert.equal((await http("GET", "/api/commands/move")).status, 200);
  assert.equal((await http("POST", "/api/commands/move")).status, 405);
});

test("a server.json left by a dead server is not trusted, even when its pid was reused", async () => {
  // A live process that is not a Pnyx server, and a port nothing listens on.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  try {
    mkdirSync(boardDir("default"), { recursive: true });
    writeFileSync(infoPath("default"), JSON.stringify({ pid: other.pid, port, url: `http://127.0.0.1:${port}`, socket: null }));

    assert.match(cli(), /^server: not running$/m);
    assert.match(cli("stop"), /^server: "none: not running"$/m);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
    server = await startServer({ board: "default" });
  } finally {
    other.kill();
  }
});
