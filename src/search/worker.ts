// The semantic search worker: one process per Pnyx home, spawned on demand by
// a search and run at low priority, never inside the board server or a hook. It
// listens on a local socket. On start it picks the models for this machine,
// downloads any that are missing (reporting progress; searches stay full-text
// meanwhile), loads the embedder, then fetches and loads the reranker. It embeds
// queries and reranks candidates for any client, and in between embeds the
// entries each board's index gained, one at a time, newest first. After a minute
// with nothing to do it exits and frees the models' memory.
// Protocol: one JSON request line per connection, answered with one JSON line.
import { createConnection, createServer, type Socket } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { rmSync, statSync } from 'node:fs'
import { SemanticError, detectMode, loadBackend, resolveChoice, type Backend } from './backend.ts'
import { EMBEDDERS, RERANKER, activeFailure, download, isInstalled, modelPath, recordFailure, type ModelFile } from './models.ts'
import { readSettings, stubbed } from './settings.ts'
import { claimVectors, openVectors, pending, putVectors } from './vectors.ts'
import { workerSocket } from './semantic.ts'

const IDLE_MS = 60_000
// How often the worker checks whether it is idle or semantic search was turned off.
const TICK_MS = 2_000
// Entries embedded between commits; a commit holds the write lock only briefly.
const BATCH = 32
const RETRY_MS = 5_000
// After a failure, how long searches stay full-text before a worker tries again.
const DOWNLOAD_COOLDOWN_MS = 10 * 60_000
const BROKEN_COOLDOWN_MS = 24 * 60 * 60_000

export type Request =
  | { op: 'status' }
  | { op: 'embed'; text: string }
  | { op: 'rerank'; query: string; docs: string[] }
  | { op: 'index'; board: string }

// Where a model stands: being fetched (bytes so far of the total), loading, ready or failed.
type Phase = { phase: 'downloading'; done: number; total: number } | { phase: 'loading' } | { phase: 'ready' } | { phase: 'failed'; message: string } | { phase: 'off' }

const settings = readSettings()
let mode = ''
let embedder: Phase = { phase: 'loading' }
let reranker: Phase = { phase: 'loading' }
let backend: Promise<Backend> | null = null
// Settles once the worker knows whether it must download the embedder, so a
// query neither waits through a download nor answers before a quick load.
let decide: () => void = () => {}
const decided = new Promise<void>(resolve => (decide = resolve))
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
    void answer({ line: buf.slice(0, end) }).then(reply => {
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

async function fetchModel({ model, track }: {
  model: ModelFile
  track: (
    { phase }: {
      phase: Phase
    },
  ) => void
}): Promise<void> {
  if (stubbed()) {
    // Tests stand in for a download's progress with PNYX_SEMANTIC_STUB_DOWNLOAD_MS.
    const ms = Number(process.env.PNYX_SEMANTIC_STUB_DOWNLOAD_MS) || 0

    for (let t = 0; t < ms; t += 100) {
      track({ phase: { phase: 'downloading', done: Math.round((model.bytes * t) / ms), total: model.bytes } })
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return
  }

  if (isInstalled({ model })) {
    return
  }

  track({ phase: { phase: 'downloading', done: 0, total: model.bytes } })
  await download({ model, progress: ({ bytes }) => track({ phase: { phase: 'downloading', done: bytes, total: model.bytes } }) })
}

// Fails this worker for a while: searches stay full-text and say why, and no new
// worker starts until the cooldown ends (or `search setup --semantic` clears it).
function fail({ error, forMs }: { error: unknown; forMs: number }): never {
  const message = (error as Error).message
  console.error((error as Error).stack)
  recordFailure({ message, forMs })
  setTimeout(shutdown, RETRY_MS)
  throw error
}

// Picks the models, fetches the embedder and loads it; then the reranker, when on.
async function prepare(): Promise<Backend> {
  try {
    mode = await detectMode()
  } catch (error) {
    embedder = { phase: 'failed', message: (error as Error).message }
    fail({ error, forMs: DOWNLOAD_COOLDOWN_MS })
  } finally {
    // A detection failure is answered as such rather than waited on.
    setTimeout(decide, 0)
  }

  const choice = resolveChoice({ settings, mode })
  const spec = EMBEDDERS[choice.model]
  reranker = choice.rerank ? { phase: 'loading' } : { phase: 'off' }

  try {
    const fetching = fetchModel({ model: spec, track: ({ phase }) => (embedder = phase) })
    decide()
    await fetching
  } catch (error) {
    embedder = { phase: 'failed', message: (error as Error).message }
    fail({ error, forMs: DOWNLOAD_COOLDOWN_MS })
  }

  embedder = { phase: 'loading' }
  let b: Backend

  try {
    b = await loadBackend({ model: choice.model })
  } catch (error) {
    embedder = { phase: 'failed', message: (error as Error).message }
    const broken = error instanceof SemanticError ? error.broken : undefined

    // A file failing its golden check is deleted, so the next attempt downloads it afresh.
    if (broken) {
      rmSync(modelPath({ model: broken }), { force: true })
    }

    fail({ error, forMs: broken ? BROKEN_COOLDOWN_MS : DOWNLOAD_COOLDOWN_MS })
  }

  embedder = { phase: 'ready' }

  const rerankFailure = choice.rerank ? activeFailure({ what: 'reranker' }) : undefined

  if (rerankFailure) {
    reranker = { phase: 'failed', message: rerankFailure }
  } else if (choice.rerank) {
    // The reranker downloads and loads in the background; searches rank without it
    // until then, and after a failure until its cooldown ends.
    void fetchModel({ model: RERANKER, track: ({ phase }) => (reranker = phase) })
      .then(() => b.rerank({ query: 'probe', docs: ['probe'] }))
      .then(() => (reranker = { phase: 'ready' }))
      .catch((error: unknown) => {
        reranker = { phase: 'failed', message: (error as Error).message }
        console.error((error as Error).stack)
        const broken = error instanceof SemanticError ? error.broken : undefined

        if (broken) {
          rmSync(modelPath({ model: broken }), { force: true })
        }

        recordFailure({ message: (error as Error).message, forMs: broken ? BROKEN_COOLDOWN_MS : DOWNLOAD_COOLDOWN_MS, what: 'reranker' })
      })
  }

  return b
}

const load = () => (backend ??= prepare())

const describe = ({ phase }: { phase: Phase }) => (phase.phase === 'downloading' ? { phase: phase.phase, done: phase.done, total: phase.total } : phase)

async function answer({ line }: { line: string }): Promise<Record<string, unknown>> {
  touch()

  try {
    const req = JSON.parse(line) as Request
    // Settings changed since this worker started: let a new one start with them.
    const now = readSettings()

    if (!now.semantic || now.model !== settings.model || now.rerank !== settings.rerank) {
      setTimeout(shutdown, 50)

      return { error: 'semantic settings changed; retry', code: 'RESTART' }
    }

    if (req.op === 'index') {
      queue.add(req.board)
      void drain()

      return { queued: req.board }
    }

    // Status and queries answer at once while a model downloads: searches stay full-text meanwhile.
    if (req.op !== 'status') {
      void load().catch(() => {})
      await decided
    }

    if (req.op === 'status' || embedder.phase === 'downloading') {
      const b = embedder.phase === 'ready' ? await load() : undefined

      return {
        ...(req.op === 'status' ? {} : { code: 'NOT_READY' }),
        mode,
        embedder: describe({ phase: embedder }),
        reranker: describe({ phase: reranker }),
        ...(b ? { key: b.key, dims: b.dims } : {}),
      }
    }

    const b = await load()

    if (req.op === 'embed') {
      return { key: b.key, floor: b.floor, rerank: reranker.phase === 'ready', reranker: describe({ phase: reranker }), vector: Array.from(await b.embed({ text: req.text })) }
    }

    if (req.op === 'rerank') {
      if (reranker.phase !== 'ready') {
        return { error: `the reranker is ${reranker.phase}`, code: 'OFF' }
      }

      return { scores: await b.rerank({ query: req.query, docs: req.docs }) }
    }

    return { error: 'unknown op', code: 'VALIDATION_ERROR' }
  } catch (error) {
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
        await indexBoard({ board, b })
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
function withVectors<T>({ board, b, fn }: {
  board: string
  b: Backend
  fn: (
    { db }: {
      db: DatabaseSync
    },
  ) => T
}): T | null {
  const db = openVectors({ board })

  if (!db) {
    return null
  }

  try {
    claimVectors({ db, key: b.key, probes: b.probes })

    return fn({ db })
  } finally {
    db.close()
  }
}

async function indexBoard({ board, b }: { board: string; b: Backend }): Promise<void> {
  while (readSettings().semantic && !closing) {
    const rows = withVectors({
      board,
      b,
      fn: ({ db }) =>
        pending({
          db,
          limit: BATCH,
          skip: failed,
        }),
    })

    if (!rows?.length) {
      return
    }

    const done: { hash: string; vector: Float32Array }[] = []

    for (const r of rows) {
      try {
        done.push({ hash: r.hash, vector: await b.embed({ text: r.body }) })
      } catch (error) {
        failed.add(r.hash)
        console.error(`skipped a chunk: ${(error as Error).message}`)
      }
    }

    withVectors({ board, b, fn: ({ db }) => putVectors({ db, rows: done }) })
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
      const busy = indexing || embedder.phase === 'downloading' || reranker.phase === 'downloading'

      if (replaced || !readSettings().semantic || (!busy && Date.now() - last > IDLE_MS)) {
        shutdown()
      }
    }, TICK_MS)
    // Start now; the request that spawned this worker needs the models.
    void load().catch(() => {})
  })
}

if (!settings.semantic) {
  process.exit(0)
}

listen()
