// The local board server: loopback HTTP for the web board and a health check, a
// Unix socket for hook events, and one WebSocket per browser tab for pushed
// changes and the tab's commands.
// It writes only through the CLI's own commands and spool drain, so the board
// keeps a single writer whether a change comes from here or from the CLI.
import { execFile } from "node:child_process";
import { readThread, threadPath, THREAD_CURSOR, type ThreadPage } from "../thread/read.ts";
import { readCatalog, type Catalog, type CatalogLocations } from "../thread/catalog.ts";
import { findCard } from "../core/decide.ts";
import { resolveHome } from "../integrations/firstmate/home.ts";
import { search, updateIndex } from "../search/index.ts";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { basename, dirname, extname, join, normalize } from "node:path";
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
// CLI commands exposed to the browser; history and card only read. push and repair stay CLI-only: push reads a file path, repair is maintenance.
const CLI_COMMANDS = ["move", "link", "outcome", "undo", "view", "history", "card"] as const;
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
// Each command gets a receipt or an error carrying its id.
export type ServerMessage =
  | { type: "thread"; thread: ThreadPage }
  | { type: "snapshot"; seq: number; state: BoardState }
  | { type: "event"; event: BoardEvent }
  | { type: "receipt"; id: string; [field: string]: unknown }
  | { type: "error"; id: string | null; error: string; code: string; help?: string[] };

export interface RunningServer {
  port: number;
  url: string;
  socket: string | null;
  close(): Promise<void>;
}

export async function startServer({ board, port = 0, homes = [], catalogLocations }: { board: string; port?: number; homes?: string[]; catalogLocations?: CatalogLocations }): Promise<RunningServer> {
  if (await readServer(board)) {
    throw new BoardError(`a server is already running for board ${board}`, "ALREADY_RUNNING", ["Run `pnyx-axi` to see its address"]);
  }
  homes = homes.map(resolveHome);
  const subscriptions = new Map<WebSocket, { card: string; watcher?: FSWatcher }>();
  const threadScheduled = new WeakSet<WebSocket>();
  const refreshThread = (ws: WebSocket) => {
    if (threadScheduled.has(ws)) return;
    threadScheduled.add(ws);
    setImmediate(() => {
      threadScheduled.delete(ws);
      if (ws.readyState !== ws.OPEN) return;
      const sub = subscriptions.get(ws), card = sub && state.cards[sub.card];
      if (!card) return;
      try { send(ws, { type: "thread", thread: readThread(board, state, card, homes) }); }
      catch { send(ws, { type: "error", id: null, code: "THREAD_UNAVAILABLE", error: "Conversation could not be refreshed" }); }
    });
  };
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
      if (subscriptions.get(ws)?.card === event.cardId) refreshThread(ws);
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
  const authorized = (given: string | null) => {
    const bytes = Buffer.from(given ?? "");
    return token.length > 0 && bytes.length === token.length && timingSafeEqual(bytes, token);
  };

  const http = createServer((req, res) => {
    if (!allowed(req)) return reply(res, 403, { error: "origin or host not allowed", code: "FORBIDDEN" });
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed", code: "METHOD_NOT_ALLOWED" });
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") return reply(res, 200, { board, pid: process.pid });
    serveStatic(res, path, token.toString());
  });

  // A tab's write: the same CLI command, pinned to this board, under the same writer lock.
  const catalogReads = new WeakMap<WebSocket, { card: string; read: Promise<Catalog> }>();
  const runCommand = (ws: WebSocket, message: { id?: unknown; name?: unknown; args?: unknown }) => {
    const id = typeof message.id === "string" ? message.id : null;
    const fail = (error: string, code: string, help?: string[]) => send(ws, { type: "error", id, error, code, help });
    const { name, args } = message;
    if (id === null) return fail("command needs a string id", "VALIDATION_ERROR");
    if (["thread", "search", "reply", "catalog"].includes(String(name))) {
      if (!Array.isArray(args) || !args.every(a => typeof a === "string")) return fail("args must be strings", "VALIDATION_ERROR");
      try {
        if (name === "catalog") {
          if (args.length !== 1) throw new BoardError("catalog expects a card", "VALIDATION_ERROR");
          const card = findCard(state, args[0]);
          let entry = catalogReads.get(ws);
          if (entry?.card !== card.id) {
            const previous = entry?.read.catch(() => undefined);
            const next = { card: card.id, read: Promise.resolve(previous).then(() => readCatalog(card, catalogLocations)) };
            catalogReads.set(ws, entry = next);
            void next.read.catch(() => undefined).finally(() => { if (catalogReads.get(ws) === next) catalogReads.delete(ws); });
          }
          void entry.read.then(catalog => send(ws, { type: "receipt", id, catalog })).catch(() => fail("Local catalog unavailable", "CATALOG_UNAVAILABLE"));
        } else if (name === "search") {
          if (args.length > 2) throw new BoardError("search expects text and optional workspace", "VALIDATION_ERROR");
          updateIndex(board);
          send(ws, { type: "receipt", id, ...search(board, { text: args[0] ?? "", workspace: args[1] || undefined, limit: 30 }) });
        } else if (name === "thread") {
          const old = subscriptions.get(ws); old?.watcher?.close(); subscriptions.delete(ws);
          if (!args[0]) { send(ws, { type: "receipt", id }); return; }
          const card = findCard(state, args[0]);
          if (args[1] !== undefined && (args[1].length > 100 || !THREAD_CURSOR.test(args[1]))) throw new BoardError("invalid thread cursor", "VALIDATION_ERROR");
          const sub: { card: string; watcher?: FSWatcher } = { card: card.id };
          const path = threadPath(card);
          if (path) { try { sub.watcher = watch(dirname(path), (_event, filename) => { if (!filename || String(filename) === basename(path)) refreshThread(ws); }); } catch { /* Missing transcript remains explicit. */ } }
          subscriptions.set(ws, sub);
          send(ws, { type: "receipt", id, thread: readThread(board, state, card, homes, args[1]) });
        } else {
          if (args.length !== 3 || !args[2] || args[1].length > 32000) throw new BoardError("reply expects card, text and idempotency key", "VALIDATION_ERROR");
          const card = findCard(state, args[0]);
          if (!card.sourceRefs.some(r => r.adapter === "firstmate" && homes.includes(r.instanceId ?? ""))) throw new BoardError("No configured reply route; draft retained", "NO_ROUTE");
          // The CLI owns reply writes and delivery. A child keeps slow native sends off the server event loop.
          execFile(process.execPath, [join(import.meta.dirname, "..", "cli", import.meta.url.endsWith(".ts") ? "reply-worker.ts" : "reply-worker.js"), card.id, "--text", args[1], "--idempotency-key", args[2], "--board", board, "--actor", "web", ...homes.flatMap(h => ["--home", h])], { timeout: 130000, maxBuffer: MAX_BODY }, (error, stdout) => {
            kick();
            if (ws.readyState !== ws.OPEN) return;
            if (error) {
              let known: { message?: unknown; code?: unknown; help?: string[] } | undefined;
              try { known = JSON.parse(stdout).error; } catch { known = undefined; }
              if (typeof known?.message === "string" && typeof known.code === "string") fail(known.message, known.code, known.help);
              else fail("Reply could not be confirmed; check receipts before sending again", "DELIVERY_UNKNOWN");
            }
            else { try { send(ws, { type: "receipt", id, ...JSON.parse(stdout) }); } catch { fail("Reply receipt unavailable; check history", "DELIVERY_UNKNOWN"); } }
          });
        }
      } catch (error) { fail((error as Error).message, error instanceof BoardError ? error.code : "UNKNOWN"); }
      return;
    }
    if (typeof name !== "string" || !(CLI_COMMANDS as readonly string[]).includes(name)) {
      return fail(`unknown command: ${String(name)}`, "NOT_FOUND", [`Use one of ${CLI_COMMANDS.join(", ")}`]);
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return fail("args must be [string, ...]", "VALIDATION_ERROR");
    if (args.some((a) => a === "--board" || a.startsWith("--board="))) {
      return fail(`--board is not allowed; this server writes board ${board}`, "VALIDATION_ERROR");
    }
    const actor = name === "history" || name === "card" || args.some((a) => a === "--actor" || a.startsWith("--actor=")) ? [] : ["--actor", "web"];
    try {
      const result = commands[name as (typeof CLI_COMMANDS)[number]]([...args, ...actor, "--board", board]);
      try { pump(); } catch { kick(); }
      send(ws, { ...result, type: "receipt", id });
    } catch (error) {
      if (!(error instanceof AxiError)) return fail((error as Error).message, "UNKNOWN");
      fail(error.message, error.code, error.suggestions);
    }
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !allowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!authorized(url.searchParams.get("token"))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("close", () => { subscriptions.get(ws)?.watcher?.close(); subscriptions.delete(ws); });
      ws.on("message", (data) => {
        const message = parseMessage(data.toString());
        if (message?.type === "resync") sendSnapshot(ws);
        else if (message?.type === "command") runCommand(ws, message);
        else send(ws, { type: "error", id: null, error: "unknown message", code: "VALIDATION_ERROR", help: ["Send a command or resync message"] });
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

type ClientMessage = { type?: unknown; id?: unknown; name?: unknown; args?: unknown };

function parseMessage(text: string): ClientMessage | undefined {
  try {
    const message = JSON.parse(text) as unknown;
    return typeof message === "object" && message !== null ? (message as ClientMessage) : undefined;
  } catch {
    return undefined;
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// The built web board from dist/web; any unknown path falls back to its index.html.
// index.html carries the token for the WebSocket handshake; the caller has already
// checked Host and Origin, so only this server's own page gets it.
function serveStatic(res: ServerResponse, path: string, token: string): void {
  const index = join(WEB_ROOT, "index.html");
  const file = normalize(join(WEB_ROOT, path === "/" ? "index.html" : path));
  for (const candidate of file.startsWith(`${WEB_ROOT}/`) ? [file, index] : []) {
    try {
      if (candidate === index) {
        const html = readFileSync(index, "utf8").replace("</head>", `<meta name="pnyx-token" content="${token}" />\n</head>`);
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" }).end(html);
        return;
      }
      const body = readFileSync(candidate);
      res.writeHead(200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" }).end(body);
      return;
    } catch {
      // Try the next candidate.
    }
  }
  reply(res, 404, { error: "not found; run `pnpm run build` for the web board", code: "NOT_FOUND" });
}

function boardFlag(args: string[], options: { port?: { type: "string" }; home?: { type: "string"; multiple: true } } = {}) {
  try {
    const { values } = parseArgs({ args, options: { board: { type: "string" }, ...options }, strict: true });
    return values as { board?: string; port?: string; home?: string[] };
  } catch (error) {
    throw new AxiError((error as Error).message, "VALIDATION_ERROR", ["Run the command with --help"]);
  }
}

// `pnyx-axi serve`: runs in the foreground until SIGINT, SIGTERM or `pnyx-axi stop`.
export async function serve(args: string[]): Promise<Record<string, unknown>> {
  const values = boardFlag(args, { port: { type: "string" }, home: { type: "string", multiple: true } });
  const board = values.board ?? "default";
  if (values.port !== undefined && !/^\d+$/.test(values.port)) {
    throw new AxiError("--port must be a number", "VALIDATION_ERROR");
  }
  let server: RunningServer;
  try {
    server = await startServer({ board, port: values.port === undefined ? 0 : Number(values.port), homes: values.home });
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

// `pnyx-axi stop`: signals the board's server and waits until it no longer answers.
export async function stop(args: string[]): Promise<Record<string, unknown>> {
  const board = boardFlag(args).board ?? "default";
  const info = await readServer(board);
  if (!info) return { server: "none: not running", help: ["Run `pnyx-axi serve` to start it"] };
  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (await readServer(board)) {
    if (Date.now() > deadline) throw new AxiError(`server pid ${info.pid} did not stop`, "TIMEOUT", [`Check process ${info.pid}`]);
    await new Promise((r) => setTimeout(r, 25));
  }
  return { server: "stopped", board };
}
