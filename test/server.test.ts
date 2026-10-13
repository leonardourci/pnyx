import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
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

const seqIs = (seq: number) => until(() => (loadBoard("default").state.seq === seq ? true : undefined), `seq ${seq}`);

async function sendToSocket(path: string, text: string): Promise<void> {
  const conn = connect(path);
  await once(conn, "connect");
  conn.end(text);
  await once(conn, "close");
}

async function tab(query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws${query}`);
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
    // Nothing arrives within a short quiet period.
    async idle() {
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(queue, []);
    },
  };
}

function http(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server!.port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text || "{}") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const write = (command: string, args: string[], headers: Record<string, string> = {}) =>
  http("POST", `/api/commands/${command}`, { authorization: `Bearer ${localToken()}`, ...headers }, JSON.stringify({ args }));

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

test("writes need the local token, an exact host and an exact origin", async () => {
  server = await startServer({ board: "default" });
  await sendToSocket(server.socket!, JSON.stringify(hookEvent("hook-1", "a", "A")));
  await seqIs(1);
  const cardId = loadBoard("default").state.keys.a!;
  const t = await tab("?after=1");

  const body = JSON.stringify({ args: [cardId, "review"] });
  assert.equal((await http("POST", "/api/commands/move", {}, body)).status, 401);
  assert.equal((await http("POST", "/api/commands/move", { authorization: "Bearer wrong" }, body)).status, 401);
  assert.equal((await write("move", [cardId, "review"], { origin: "http://evil.example" })).status, 403);
  assert.equal((await write("move", [cardId, "review"], { origin: `http://127.0.0.1:${server.port}.evil.example` })).status, 403);
  assert.equal((await write("move", [cardId, "review"], { host: `evil.example:${server.port}` })).status, 403);
  assert.equal((await http("GET", "/", { host: `evil.example:${server.port}` })).status, 403);
  assert.equal((await write("push", ["--key", "x", "--file", "/etc/hosts"])).status, 404);
  assert.equal((await http("POST", "/api/commands/move", { authorization: `Bearer ${localToken()}` }, "{}")).status, 400);
  const missing = await write("move", ["no-such-card", "review"]);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
  await t.idle();
  assert.equal(loadBoard("default").state.seq, 1);

  const ok = await write("move", [cardId, "review"], { origin: `http://localhost:${server.port}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.card, { id: cardId, column: "review", revision: 2 });
  const pushed = await t.next();
  assert.equal(pushed.type === "event" && pushed.event.type, "card.moved");

  const foreign = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { origin: "http://evil.example" } });
  const [, response] = await once(foreign, "unexpected-response");
  assert.equal(response.statusCode, 403);
});
