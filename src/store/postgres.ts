import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import { CONFLICT_CODE, HydraError } from './errors.ts'
import type { ErrorDetails } from './error-details.ts'
import { configuredPostgres } from '#settings/store.ts'
import { pnyxHome } from './paths.ts'

// Its own entry file, so the worker runs only the connection.
const WORKER_ENTRY = new URL(
  import.meta.url.endsWith('.ts') ? './postgres-worker.ts' : './postgres-worker.js',
  import.meta.url,
)
// A request the server waits on longer than this has a stuck connection behind it; Postgres cancels a slow statement
// itself well before (STATEMENT_TIMEOUT_MS in the worker).
const PROGRESS_POLL_MS = 1000
const QUERY_TIMEOUT_MS = 30_000
// Postgres refuses U+0000 and a lone UTF-16 surrogate even in json columns, so one stored value holding either would
// fail every later write.
const NUL = '\u0000'
const REPLACEMENT = '\ufffd'
const LIVE_DATABASE = 'pnyx'
const CONDITIONS = '--conditions='

export interface Statement {
  text: string
  values?: unknown[]
  // A conditional write that must change exactly this many rows, or its transaction fails as a conflict.
  expectRows?: number
}

export interface Request {
  id: number
  statements: Statement[]
  transaction: boolean
  // A trial runs every statement and then rolls the transaction back.
  rollback?: boolean
  // How long each statement of this transaction may run, for one that outlasts an ordinary statement's limit.
  statementTimeoutMs?: number
}

export interface QueryTimings {
  connectionWaitMs: number
  commitMs: number
}

export type Outcome = {
  results: Record<string, unknown>[][]
  timings: QueryTimings
} | {
  error: ErrorDetails
}

export type Reply = { id: number } & Outcome

interface Connection {
  worker: Worker
  port: MessagePort
  signal: Int32Array
}

const connections = new Map<string, Connection>()
let requests = 0
// A refused conditional write, a serialization failure, and a duplicate key, such as an event seq or id already taken.
const CONFLICTS = new Set([
  CONFLICT_CODE,
  '40001',
  '23505',
])

// A connection that failed or dropped, and a statement Postgres cancelled for a timeout or a lock, can pass when tried
// again; anything else, such as a constraint the data breaks, fails the same way every time.
const UNAVAILABLE = /^(08|57)|^55P03$/
const SQLSTATE = /^[0-9A-Z]{5}$/

function failureCode({ code = '' }: { code?: string }): string {
  if (CONFLICTS.has(code)) {
    return 'CONFLICT'
  }

  if (!SQLSTATE.test(code) || UNAVAILABLE.test(code)) {
    return 'DATABASE_UNAVAILABLE'
  }

  return 'DATABASE_ERROR'
}

// The live home's database is pnyx; every other home, such as the dev home or a test's, gets its own name, so two
// homes never share one. Host, port and user come from the usual libpq environment (PGHOST, PGPORT, PGUSER).
export function homeDatabase({ home = pnyxHome() }: { home?: string } = {}): string {
  const path = resolve(home)

  if (path === join(
    homedir(),
    '.pnyx',
  )) {
    return LIVE_DATABASE
  }

  return `pnyx_${createHash('sha256').update(path)
    .digest('hex')
    .slice(
      0,
      16,
    )}`
}

// A key for caches of one home's Hydra, so a process that moves between homes, as tests do, never mixes them.
export const homeScoped = ({ hydraId }: { hydraId: string }) => `${homeDatabase()}\u0000${hydraId}`

function connection({ url }: { url?: string }): Connection {
  const database = homeDatabase()
  const key = url ?? database
  const known = connections.get(key)

  if (known) {
    return known
  }

  const {
    port1,
    port2,
  } = new MessageChannel()
  const signal = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT))
  const worker = new Worker(
    WORKER_ENTRY,
    {
      workerData: {
        port: port2,
        signal,
        config: url ? {
          connectionString: url,
          database: new URL(url).pathname.slice(1) || database,
        } : { database },
      },
      transferList: [port2],
      // The worker needs only the import conditions; a flag such as --input-type from `node -e` would stop it loading.
      execArgv: process.execArgv.filter(arg => arg.startsWith(CONDITIONS)),
      // The worker prints nothing; left unpiped, its streams add no listener per home and keep no command running.
      stdout: true,
      stderr: true,
    },
  )
  // The connection lives as long as the process and never keeps it running.
  worker.unref()
  port1.unref()
  const opened = {
    worker,
    port: port1,
    signal,
  }
  connections.set(
    key,
    opened,
  )
  // A worker that died is replaced on the next request; its error reached the caller as a timeout.
  worker.once(
    'error',
    () => undefined,
  )
  worker.once(
    'exit',
    () => {
      if (connections.get(key) === opened) {
        connections.delete(key)
      }
    },
  )

  return opened
}

// Setup owns these clients; await their exit before Homebrew's smart shutdown waits for them.
export async function closePostgres(): Promise<void> {
  const opened = [...connections.values()]
  connections.clear()
  await Promise.all(opened.map(async ({
    worker,
    port,
  }) => {
    port.close()
    await worker.terminate()
  }))
}

const configuredUrls = new Map<string, string>()

// The postgresUrl setting, read once per home: zero-cache and the held Hydras keep the connection they opened, so a
// change applies when the server restarts.
export function configuredUrl(): string | undefined {
  const database = homeDatabase()

  if (!configuredUrls.has(database)) {
    configuredUrls.set(
      database,
      configuredPostgres(),
    )
  }

  const url = configuredUrls.get(database)

  if (url === '') {
    return undefined
  }

  return url
}

// Replaces U+0000 and lone surrogates with U+FFFD in every string and key of a record headed for Postgres, in place, so
// memory and rows keep the same text.
export function storable<Value>({ value }: { value: Value }): Value {
  if (typeof value === 'string') {
    return value.toWellFormed().replaceAll(
      NUL,
      REPLACEMENT,
    ) as Value
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>

    for (const key of Object.keys(record)) {
      const cleaned = storable({ value: key })
      const item = storable({ value: record[key] })

      if (cleaned !== key) {
        delete record[key]
      }

      record[cleaned] = item
    }
  }

  return value
}

// Runs statements on the home's database and waits for them, so the writer and the reducer stay synchronous. A
// transaction commits all of them or none.
export function query({
  statements,
  transaction = false,
  rollback = false,
  url,
  timeoutMs = QUERY_TIMEOUT_MS,
  progress,
  timed,
}: {
  timed?({ timings }: { timings: QueryTimings }): void
  statements: Statement[]
  transaction?: boolean
  rollback?: boolean
  url?: string
  // An import writes a whole Hydra in one transaction, which can outlast an ordinary statement's wait.
  timeoutMs?: number
  progress?(): void
}): Record<string, unknown>[][] {
  const target = url ?? configuredUrl()
  const open = connection({ url: target })
  requests += 1
  const id = requests
  Atomics.store(
    open.signal,
    0,
    0,
  )
  const request: Request = {
    id,
    statements,
    transaction,
    rollback,
  }

  if (timeoutMs !== QUERY_TIMEOUT_MS) {
    request.statementTimeoutMs = timeoutMs
  }

  open.port.postMessage(request)
  const deadline = performance.now() + timeoutMs
  let observed = Atomics.load(
    open.signal,
    1,
  )
  let waited: 'ok' | 'not-equal' | 'timed-out'

  do {
    const remaining = Math.max(
      0,
      deadline - performance.now(),
    )
    waited = Atomics.wait(
      open.signal,
      0,
      0,
      progress ? Math.min(
        PROGRESS_POLL_MS,
        remaining,
      ) : remaining,
    )
    const advanced = Atomics.load(
      open.signal,
      1,
    )

    if (progress && observed !== advanced) {
      progress()
      observed = advanced
    }
  } while (waited === 'timed-out' && performance.now() < deadline)

  const reply = receiveMessageOnPort(open.port)?.message as Reply | undefined

  // A request left running past its wait could still answer later; that worker goes, so its reply never answers the
  // next request, and the next request opens a new connection.
  if (waited === 'timed-out' || reply?.id !== id) {
    // Nothing here can wait for the worker to stop; whatever it still holds ends with it.
    open.worker.terminate().catch(() => undefined)
    connections.delete(target ?? homeDatabase())
    throw new HydraError({
      message: `Postgres did not answer within ${timeoutMs / 1000}s`,
      code: 'DATABASE_TIMEOUT',
      help: ['Run `pnyx-axi setup check` to see whether Postgres is running'],
    })
  }

  if ('error' in reply) {
    throw new HydraError({
      message: `Postgres: ${reply.error.message}`,
      cause: reply.error,
      code: failureCode({ code: reply.error.code }),
      help: ['Run `pnyx-axi setup check` to see whether Postgres is running and configured'],
    })
  }

  timed?.({ timings: reply.timings })

  return reply.results
}
