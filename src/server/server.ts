// The local board server: loopback HTTP for writes and the web board, a Unix
// socket for hook events, and one WebSocket per browser tab for pushed changes.
// It writes only through the CLI's own commands and spool drain, so the board
// keeps a single writer whether a change comes from here or from the CLI.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";
import { WebSocketServer, type WebSocket } from "ws";
import { commands, ingestSpool } from "../cli/commands.ts";
import { BoardError, type BoardEvent, type BoardState } from "../core/model.ts";
import { reduce } from "../core/reducer.ts";
import { boardDir, loadBoard, readEventsFrom, spoolDir, spoolFiles, spoolWrite } from "../store/board-store.ts";
import { infoPath, localToken, readServer, socketPath, type ServerInfo } from "./state.ts";

// Events kept in memory for cursor resume; an older cursor gets a snapshot instead.
const RESUME_LIMIT = 1000;
// A tab with more than this unsent is dropped from the event stream and resynced with a snapshot.
const MAX_BUFFERED = 1 << 20;
const MAX_BODY = 1 << 20;
const STOP_TIMEOUT_MS = 5000;
// Writes a browser may make. push and repair stay CLI-only: push reads a file path, repair is maintenance.
const WRITE_COMMANDS = ["move", "link", "outcome", "undo"] as const;
// Same relative path from src/server and dist/server.
const WEB_ROOT = join(import.meta.dirname, "..", "..", "dist", "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Server to browser. A snapshot replaces whatever the tab held; events then follow in sequence.
export type ServerMessage = { type: "snapshot"; seq: number; state: BoardState } | { type: "event"; event: BoardEvent };

export interface RunningServer {
  port: number;
  url: string;
  socket: string | null;
  close(): Promise<void>;
}

export async function startServer({ board, port = 0 }: { board: string; port?: number }): Promise<RunningServer> {
  if (readServer(board)) {
    throw new BoardError(`a server is already running for board ${board}`, "ALREADY_RUNNING", ["Run `pnyx-axi` to see its address"]);
  }
  const dir = boardDir(board);
  mkdirSync(spoolDir(dir), { recursive: true });
  const token = Buffer.from(localToken());
  let { state, offset } = loadBoard(board);
  let recent: BoardEvent[] = [];
  const resyncing = new WeakSet<WebSocket>();

  const send = (ws: WebSocket, message: ServerMessage) => {
    if (ws.bufferedAmount > MAX_BUFFERED) {
      resyncing.add(ws);
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const sendSnapshot = (ws: WebSocket) => {
    resyncing.delete(ws);
    send(ws, { type: "snapshot", seq: state.seq, state });
  };
  // ponytail: a lagging tab gets its snapshot on the next change, not when its buffer drains.
  const broadcast = (event: BoardEvent) => {
    for (const ws of wss.clients) {
      if (!resyncing.has(ws)) send(ws, { type: "event", event });
      else if (ws.bufferedAmount <= MAX_BUFFERED) sendSnapshot(ws);
    }
  };
  const reload = () => {
    ({ state, offset } = loadBoard(board));
    recent = [];
    for (const ws of wss.clients) sendSnapshot(ws);
  };

  // Folds whatever was appended since the last read, from this server or the CLI.
  const pump = () => {
    const read = readEventsFrom(board, offset);
    if (!read) return reload();
    for (const event of read.events) {
      if (event.seq !== state.seq + 1) return reload();
      state = reduce(state, event);
      recent.push(event);
      broadcast(event);
    }
    offset = read.end;
    if (recent.length > RESUME_LIMIT) recent = recent.slice(-RESUME_LIMIT);
  };

  // Coalesces watcher bursts into one drain-and-pump per tick.
  let scheduled = false;
  const kick = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      try {
        if (spoolFiles(dir).length > 0) ingestSpool(board);
        pump();
      } catch (error) {
        // A held lock or a damaged log; the next change retries.
        console.error(`pnyx-axi serve: ${(error as Error).message}`);
      }
    });
  };

  // Exact matches only, so another site or a rebound DNS name is refused. Clients
  // that send no Origin are local programs, not pages; writes still need the token.
  const hosts = new Set<string>();
  const origins = new Set<string>();
  const allowed = (req: IncomingMessage) =>
    hosts.has(req.headers.host ?? "") && (req.headers.origin === undefined || origins.has(req.headers.origin));
  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    return token.length > 0 && given.length === token.length && timingSafeEqual(given, token);
  };

  const http = createServer((req, res) => {
    if (!allowed(req)) return reply(res, 403, { error: "origin or host not allowed", code: "FORBIDDEN" });
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const command = /^\/api\/commands\/([a-z]+)$/.exec(path)?.[1];
    if (command !== undefined) return void handleCommand(req, res, command);
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed", code: "METHOD_NOT_ALLOWED" });
    serveStatic(res, path);
  });

  const handleCommand = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    if (req.method !== "POST") return reply(res, 405, { error: "use POST", code: "METHOD_NOT_ALLOWED" });
    if (!authorized(req)) return reply(res, 401, { error: "missing or wrong token", code: "UNAUTHORIZED" });
    if (!(WRITE_COMMANDS as readonly string[]).includes(name)) {
      return reply(res, 404, { error: `unknown command: ${name}`, code: "NOT_FOUND", help: [`Use one of ${WRITE_COMMANDS.join(", ")}`] });
    }
    let args: unknown;
    try {
      args = (JSON.parse(await readBody(req)) as { args?: unknown }).args;
    } catch {
      args = undefined;
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      return reply(res, 400, { error: 'body must be {"args": [string, ...]}', code: "VALIDATION_ERROR" });
    }
    try {
      reply(res, 200, commands[name as (typeof WRITE_COMMANDS)[number]](args));
      kick();
    } catch (error) {
      if (!(error instanceof AxiError)) return reply(res, 500, { error: (error as Error).message, code: "UNKNOWN" });
      const status = error.code === "VALIDATION_ERROR" ? 400 : error.code === "NOT_FOUND" ? 404 : 409;
      reply(res, status, { error: error.message, code: error.code, help: error.suggestions });
    }
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !allowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        if (parseMessage(data.toString())?.type === "resync") sendSnapshot(ws);
      });
      resume(ws, url.searchParams.get("after"));
    });
  });

  // A cursor this server can continue from gets only the events after it; any
  // other cursor (ahead of the board, older than the kept events, or none) gets a snapshot.
  const resume = (ws: WebSocket, after: string | null) => {
    const seq = after !== null && /^\d+$/.test(after) ? Number(after) : undefined;
    if (seq === state.seq) return;
    const first = recent[0]?.seq ?? state.seq + 1;
    if (seq === undefined || seq > state.seq || seq < first - 1) return sendSnapshot(ws);
    for (const event of recent) if (event.seq > seq) send(ws, { type: "event", event });
  };

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve());
  });
  const bound = (http.address() as { port: number }).port;
  for (const host of [`127.0.0.1:${bound}`, `localhost:${bound}`]) {
    hosts.add(host);
    origins.add(`http://${host}`);
  }

  const ingest = await listenIngest(board, (line) => {
    try {
      const entry = JSON.parse(line) as { id?: unknown };
      if (typeof entry === "object" && entry !== null && typeof entry.id === "string") {
        spoolWrite(board, entry as { id: string });
      }
    } catch {
      // Not JSON: dropped, as a hook never waits for an answer.
    }
    kick();
  });

  const watchers: FSWatcher[] = [watch(dir, kick), watch(spoolDir(dir), kick)];
  const url = `http://127.0.0.1:${bound}`;
  const info: ServerInfo = { pid: process.pid, port: bound, url, socket: ingest && socketPath(board) };
  const tmp = `${infoPath(board)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, infoPath(board));
  // Events spooled while no server ran.
  kick();

  return {
    port: bound,
    url,
    socket: info.socket,
    async close() {
      for (const w of watchers) w.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await Promise.all([new Promise((r) => http.close(r)), ingest && new Promise((r) => ingest.close(r))]);
      rmSync(infoPath(board), { force: true });
      if (ingest) rmSync(socketPath(board), { force: true });
    },
  };
}

// Hook events, one JSON object per line. Null when the socket cannot be bound
// (a path too long for a Unix socket, say); hooks then spool and the watcher drains it.
async function listenIngest(board: string, onLine: (line: string) => void): Promise<SocketServer | null> {
  const path = socketPath(board);
  // Left by a server that did not stop cleanly; startServer already checked none is running.
  rmSync(path, { force: true });
  const server = createSocketServer((conn) => {
    let buffered = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_BODY) return conn.destroy();
      for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
        onLine(buffered.slice(0, i));
        buffered = buffered.slice(i + 1);
      }
    });
    conn.on("end", () => {
      if (buffered.trim()) onLine(buffered);
      conn.end();
    });
    conn.on("error", () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
  } catch {
    return null;
  }
  chmodSync(path, 0o600);
  return server;
}

function parseMessage(text: string): { type?: unknown } | undefined {
  try {
    return JSON.parse(text) as { type?: unknown };
  } catch {
    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// The built web board from dist/web; any unknown path falls back to its index.html.
function serveStatic(res: ServerResponse, path: string): void {
  const file = normalize(join(WEB_ROOT, path === "/" ? "index.html" : path));
  for (const candidate of file.startsWith(`${WEB_ROOT}/`) ? [file, join(WEB_ROOT, "index.html")] : []) {
    try {
      const body = readFileSync(candidate);
      res.writeHead(200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" }).end(body);
      return;
    } catch {
      // Try the next candidate.
    }
  }
  reply(res, 404, { error: "not found; run `pnpm run build` for the web board", code: "NOT_FOUND" });
}

function boardFlag(args: string[], options: { port?: { type: "string" } } = {}) {
  try {
    const { values } = parseArgs({ args, options: { board: { type: "string" }, ...options }, strict: true });
    return values as { board?: string; port?: string };
  } catch (error) {
    throw new AxiError((error as Error).message, "VALIDATION_ERROR", ["Run the command with --help"]);
  }
}

// `pnyx-axi serve`: runs in the foreground until SIGINT, SIGTERM or `pnyx-axi stop`.
export async function serve(args: string[]): Promise<Record<string, unknown>> {
  const values = boardFlag(args, { port: { type: "string" } });
  const board = values.board ?? "default";
  if (values.port !== undefined && !/^\d+$/.test(values.port)) {
    throw new AxiError("--port must be a number", "VALIDATION_ERROR");
  }
  let server: RunningServer;
  try {
    server = await startServer({ board, port: values.port === undefined ? 0 : Number(values.port) });
  } catch (error) {
    if (error instanceof BoardError) throw new AxiError(error.message, error.code, error.help);
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new AxiError(`port ${values.port} is in use`, "PORT_IN_USE", ["Pick another --port, or omit it for a random one"]);
    }
    throw error;
  }
  // TOON for a flat object is `key: value`; JSON quoting keeps the values valid TOON.
  process.stdout.write(`server: running\nboard: ${board}\nurl: ${JSON.stringify(server.url)}\nhelp[1]: Run \`pnyx-axi stop\` to stop it\n`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  return { server: "stopped", board };
}

// `pnyx-axi stop`: signals the board's server and waits for it to remove server.json.
export function stop(args: string[]): Record<string, unknown> {
  const board = boardFlag(args).board ?? "default";
  const info = readServer(board);
  if (!info) return { server: "none: not running", help: ["Run `pnyx-axi serve` to start it"] };
  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (readServer(board)) {
    if (Date.now() > deadline) throw new AxiError(`server pid ${info.pid} did not stop`, "TIMEOUT", [`Check process ${info.pid}`]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return { server: "stopped", board };
}
