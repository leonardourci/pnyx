import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import { CONFLICT_CODE, HydraError } from './errors.ts'
import { configuredPostgres } from '#settings/store.ts'
import { pnyxHome } from './paths.ts'

// Its own entry file, so the worker runs only the connection.
const WORKER_ENTRY = new URL(
  import.meta.url.endsWith('.ts') ? './postgres-worker.ts' : './postgres-worker.js',
  import.meta.url,
)
// A statement the server waits on longer than this has a stuck connection behind it.
const QUERY_TIMEOUT_MS = 30_000
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
}

export type Reply = { id: number } & ({ results: Record<string, unknown>[][] } | {
  error: {
    message: string
    code?: string
  }
})

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
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
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

// Runs statements on the home's database and waits for them: the writer and the reducer stay synchronous, as they
// were over fsynced files. A transaction commits all of them or none.
export function query({
  statements,
  transaction = false,
  rollback = false,
  url,
}: {
  statements: Statement[]
  transaction?: boolean
  rollback?: boolean
  url?: string
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
  open.port.postMessage({
    id,
    statements,
    transaction,
    rollback,
  } satisfies Request)
  const waited = Atomics.wait(
    open.signal,
    0,
    0,
    QUERY_TIMEOUT_MS,
  )
  const reply = receiveMessageOnPort(open.port)?.message as Reply | undefined

  // A request left running past its wait could still answer later; that worker goes, so its reply never answers the
  // next request, and the next request opens a new connection.
  if (waited === 'timed-out' || reply?.id !== id) {
    void open.worker.terminate()
    connections.delete(target ?? homeDatabase())
    throw new HydraError({
      message: `Postgres did not answer within ${QUERY_TIMEOUT_MS / 1000}s`,
      code: 'DATABASE_TIMEOUT',
      help: ['Run `pnyx-axi setup check` to see whether Postgres is running'],
    })
  }

  if ('error' in reply) {
    throw new HydraError({
      message: `Postgres: ${reply.error.message}`,
      code: CONFLICTS.has(reply.error.code ?? '') ? 'CONFLICT' : 'DATABASE_ERROR',
      help: ['Run `pnyx-axi setup check` to see whether Postgres is running and configured'],
    })
  }

  return reply.results
}
