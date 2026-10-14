// The semantic search worker: one process per Pnyx home, spawned on demand by
// a search and run at low priority, never inside the board server or a hook. It
// listens on a local socket, loads the embedder (and the reranker on first use),
// embeds queries and reranks candidates for any client, and in between embeds the
// entries each board's index gained, one at a time, newest first. After a minute
// with nothing to do it exits and frees the models' memory.
// Protocol: one JSON request line per connection, answered with one JSON line.
import { createConnection, createServer, type Socket } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { rmSync, statSync } from 'node:fs'
import { loadBackend, type Backend } from './backend.ts'
import { readSettings } from './settings.ts'
import { claimVectors, openVectors, pending, putVectors } from './vectors.ts'
import { workerSocket } from './semantic.ts'

const IDLE_MS = 60_000
// How often the worker checks whether it is idle or semantic search was turned off.
const TICK_MS = 2_000
// Entries embedded between commits; a commit holds the write lock only briefly.
const BATCH = 32
const RETRY_MS = 5_000

export type Request =
  | { op: 'status' }
  | { op: 'embed'; text: string }
  | { op: 'rerank'; query: string; docs: string[] }
  | { op: 'index'; board: string }

const settings = readSettings()
let backend: Promise<Backend> | null = null
const queue = new Set<string>()
let indexing = false
let last = Date.now()
// Requests being answered; shutdown waits for them.
let answering = 0
let closing = false
// The socket file this worker bound, by inode; another worker may since have replaced it.
let bound = ''
// Chunks the embedder failed on, skipped until this worker exits.
const failed = new Set<string>()

const server = createServer(socket => {
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', data => {
    buf += data
    const end = buf.indexOf('\n')

    if (end < 0) {
      return
    }

    answering += 1
    void answer(buf.slice(0, end)).then(reply => {
      socket.end(`${JSON.stringify(reply)}\n`)
      answering -= 1
    })
  })
  socket.on('error', () => {})
})

const touch = () => (last = Date.now())

const socketId = () => {
  try {
    const s = statSync(workerSocket())

    return `${s.dev}:${s.ino}`
  } catch {
    return ''
  }
}

// Stops taking requests and exits once those in hand are answered. Closing the
// server removes the socket file, so a worker whose file was replaced exits without closing.
function shutdown(): void {
  if (closing) {
    return
  }

  closing = true

  if (process.platform === 'win32' || socketId() === bound) {
    server.close()
  }

  const exit = () => (answering === 0 ? process.exit(0) : setTimeout(exit, 50))
  exit()
}

const load = () => (backend ??= loadBackend(settings.model))

async function answer(line: string): Promise<Record<string, unknown>> {
  touch()

  try {
    const req = JSON.parse(line) as Request
    // Settings changed since this worker started: let a new one start with them.
    const now = readSettings()

    if (!now.semantic || now.model !== settings.model) {
      setTimeout(shutdown, 50)

      return { error: 'semantic settings changed; retry', code: 'RESTART' }
    }

    if (req.op === 'index') {
      queue.add(req.board)
      void drain()

      return { queued: req.board }
    }

    const b = await load()

    if (req.op === 'status') {
      return { mode: b.mode, key: b.key, dims: b.dims }
    }

    if (req.op === 'embed') {
      return { key: b.key, vector: Array.from(await b.embed(req.text)) }
    }

    if (req.op === 'rerank') {
      if (!now.rerank) {
        return { error: 'the reranker is off', code: 'OFF' }
      }

      return { scores: await b.rerank(req.query, req.docs) }
    }

    return { error: 'unknown op', code: 'VALIDATION_ERROR' }
  } catch (error) {
    // A backend that failed to load stays failed; exit soon so a later search retries it.
    if (backend) {
      void backend.catch(() => setTimeout(shutdown, RETRY_MS))
    }

    // Its output is semantic.log in the Pnyx home.
    console.error((error as Error).stack)

    return { error: (error as Error).message, code: 'UNAVAILABLE' }
  }
}

// Embeds what each queued board's index lacks. Errors (a board mid-rebuild, a
// busy lock) drop the board until the next search queues it again.
async function drain(): Promise<void> {
  if (indexing) {
    return
  }

  indexing = true

  try {
    const b = await load()

    for (const board of queue) {
      queue.delete(board)

      try {
        await indexBoard(board, b)
      } catch {
        // The next index request retries.
      }
    }
  } catch {
    queue.clear()
  } finally {
    indexing = false
    touch()
  }
}

// Runs one step against the board's index, closed again before any embedding:
// the file may be rebuilt meanwhile (and Windows cannot delete an open file).
function withVectors<T>(board: string, b: Backend, fn: (db: DatabaseSync) => T): T | null {
  const db = openVectors(board)

  if (!db) {
    return null
  }

  try {
    claimVectors(db, b.key, b.probes)

    return fn(db)
  } finally {
    db.close()
  }
}

async function indexBoard(board: string, b: Backend): Promise<void> {
  while (readSettings().semantic && !closing) {
    const rows = withVectors(board, b, db => pending(db, BATCH, failed))

    if (!rows?.length) {
      return
    }

    const done: { hash: string; vector: Float32Array }[] = []

    for (const r of rows) {
      try {
        done.push({ hash: r.hash, vector: await b.embed(r.body) })
      } catch (error) {
        failed.add(r.hash)
        console.error(`skipped a chunk: ${(error as Error).message}`)
      }
    }

    withVectors(board, b, db => putVectors(db, done))
  }
}

// Binds the socket, unless another worker already answers on it.
function listen(): void {
  const path = workerSocket()
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') {
      process.exit(1)
    }

    const probe: Socket = createConnection(path)
    probe.once('connect', () => process.exit(0))
    probe.once('error', () => {
      rmSync(path, { force: true })
      server.listen(path)
    })
  })
  server.listen(path, () => {
    bound = socketId()
    setInterval(() => {
      const replaced = process.platform !== 'win32' && socketId() !== bound

      if (replaced || !readSettings().semantic || (!indexing && Date.now() - last > IDLE_MS)) {
        shutdown()
      }
    }, TICK_MS)
    // Start loading the models now; the request that spawned this worker needs them.
    void load().catch(() => {})
  })
}

if (!settings.semantic) {
  process.exit(0)
}

listen()
