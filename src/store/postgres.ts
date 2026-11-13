import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import { HydraError } from './errors.ts'
import { pnyxHome } from './paths.ts'

// Its own entry file, so the worker runs only the connection.
const WORKER_ENTRY = new URL(
  import.meta.url.endsWith('.ts') ? './postgres-worker.ts' : './postgres-worker.js',
  import.meta.url,
)
// A statement the server waits on longer than this has a stuck connection behind it.
const QUERY_TIMEOUT_MS = 30_000
const LIVE_DATABASE = 'pnyx'
// What the worker reports when a conditional write matched another row count.
export const CONFLICT_CODE = 'PNYX_CONFLICT'

export interface Statement {
  text: string
  values?: unknown[]
  // A conditional write that must change exactly this many rows, or its transaction fails as a conflict.
  expectRows?: number
}

export interface Request {
  statements: Statement[]
  transaction: boolean
}

export type Reply = { results: Record<string, unknown>[][] } | {
  error: {
    message: string
    code?: string
    constraint?: string
  }
}

interface Connection {
  worker: Worker
  port: MessagePort
  signal: Int32Array
}

const connections = new Map<string, Connection>()

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
      // The worker prints nothing; piping its stdout into ours would add a listener per database a process opens.
      stdout: true,
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

  return opened
}

// Runs statements on the home's database and waits for them: the writer and the reducer stay synchronous, as they
// were over fsynced files. A transaction commits all of them or none.
export function query({
  statements,
  transaction = false,
  url,
}: {
  statements: Statement[]
  transaction?: boolean
  url?: string
}): Record<string, unknown>[][] {
  const open = connection({ url })
  Atomics.store(
    open.signal,
    0,
    0,
  )
  open.port.postMessage({
    statements,
    transaction,
  } satisfies Request)
  const waited = Atomics.wait(
    open.signal,
    0,
    0,
    QUERY_TIMEOUT_MS,
  )
  const reply = receiveMessageOnPort(open.port)?.message as Reply | undefined

  if (waited === 'timed-out' || !reply) {
    throw new HydraError({
      message: `Postgres did not answer within ${QUERY_TIMEOUT_MS / 1000}s`,
      code: 'DATABASE_TIMEOUT',
      help: ['Run `pnyx-axi setup check` to see whether Postgres is running'],
    })
  }

  if ('error' in reply) {
    throw new HydraError({
      message: `Postgres: ${reply.error.message}`,
      code: reply.error.code === CONFLICT_CODE || reply.error.code === '40001' || reply.error.constraint
        ? 'CONFLICT'
        : 'DATABASE_ERROR',
      help: ['Run `pnyx-axi setup check` to see whether Postgres is running and configured'],
    })
  }

  return reply.results
}
