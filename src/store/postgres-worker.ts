import { readFileSync } from 'node:fs'
import { workerData, type MessagePort } from 'node:worker_threads'
import pg from 'pg'
import { CONFLICT_CODE } from './errors.ts'
import type { Reply, Request, Statement } from './postgres.ts'

const MISSING_DATABASE = '3D000'
const DUPLICATE_DATABASE = '42P04'
const CONNECTION_LOST = [
  '08',
  '57P',
]

const {
  port,
  signal,
  config,
} = workerData as {
  port: MessagePort
  signal: Int32Array
  config: pg.ClientConfig & { database: string }
}

// The same server's maintenance database, which can create this one; a connection string names its database itself.
function adminConfig(): pg.ClientConfig {
  if (!config.connectionString) {
    return {
      ...config,
      database: 'postgres',
    }
  }

  const url = new URL(config.connectionString)
  url.pathname = '/postgres'

  return { connectionString: url.href }
}

// A home's database appears on its first use, with the folded migration applied once.
async function connect(): Promise<pg.Client> {
  const client = new pg.Client(config)

  // A dropped connection, as when Postgres restarts, is replaced on the next request.
  const drop = () => {
    ready = undefined
  }

  client.on(
    'error',
    drop,
  )
  client.on(
    'end',
    drop,
  )

  try {
    await client.connect()
  } catch (error) {
    if ((error as { code?: string }).code !== MISSING_DATABASE) {
      throw error
    }

    const admin = new pg.Client(adminConfig())
    await admin.connect()

    try {
      await admin.query(`create database ${pg.escapeIdentifier(config.database)}`)
    } catch (createError) {
      if ((createError as { code?: string }).code !== DUPLICATE_DATABASE) {
        throw createError
      }
    } finally {
      await admin.end()
    }

    return connect()
  }

  // Two processes opening a new home at once migrate it once.
  await client.query('select pg_advisory_lock(hashtext(\'pnyx schema\'))')

  try {
    const { rows } = await client.query<{ table: string | null }>('select to_regclass(\'public.hydras\') as table')

    if (!rows[0]?.table) {
      await client.query(readFileSync(
        new URL(
          './schema.sql',
          import.meta.url,
        ),
        'utf8',
      ))
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext(\'pnyx schema\'))')
  }

  return client
}

let ready: Promise<pg.Client> | undefined

// A connection that failed to open is tried again on the next request, so Pnyx recovers once Postgres is up.
async function connection(): Promise<pg.Client> {
  const opening = ready ?? connect()
  ready = opening

  try {
    return await opening
  } catch (error) {
    ready = undefined
    throw error
  }
}

async function execute({
  client,
  statement,
}: {
  client: pg.Client
  statement: Statement
}): Promise<Record<string, unknown>[]> {
  const result = await client.query({
    text: statement.text,
    values: statement.values,
  })

  if (statement.expectRows !== undefined && result.rowCount !== statement.expectRows) {
    throw Object.assign(
      new Error(`expected ${statement.expectRows} changed rows, got ${result.rowCount}`),
      { code: CONFLICT_CODE },
    )
  }

  return result.rows
}

async function run({ request }: { request: Request }): Promise<Omit<Reply, 'id'>> {
  try {
    const client = await connection()

    if (!request.transaction) {
      const results = []

      for (const statement of request.statements) {
        results.push(await execute({
          client,
          statement,
        }))
      }

      return { results }
    }

    await client.query('begin')

    try {
      const results = []

      for (const statement of request.statements) {
        results.push(await execute({
          client,
          statement,
        }))
      }

      await client.query(request.rollback ? 'rollback' : 'commit')

      return { results }
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  } catch (error) {
    const failure = error as {
      message?: string
      code?: string
    }

    // A connection exception (08), a shutdown or restart (57P) or an error without a code ends the connection, so the
    // next request opens another.
    const { code } = failure

    if (code === undefined || CONNECTION_LOST.some(prefix => code.startsWith(prefix))) {
      ready = undefined
    }

    return {
      error: {
        message: failure.message ?? String(error),
        code: failure.code,
      },
    }
  }
}

// One request at a time on the one connection, so no request's statements land inside another's transaction.
let running = Promise.resolve()

port.on(
  'message',
  (request: Request) => {
    running = running.then(async () => {
      port.postMessage({
        id: request.id,
        ...await run({ request }),
      })
      Atomics.store(
        signal,
        0,
        1,
      )
      Atomics.notify(
        signal,
        0,
      )
    })
  },
)
