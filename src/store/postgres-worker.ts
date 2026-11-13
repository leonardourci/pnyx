import { readFileSync } from 'node:fs'
import { workerData, type MessagePort } from 'node:worker_threads'
import pg from 'pg'
import { CONFLICT_CODE, type Reply, type Request, type Statement } from './postgres.ts'

const MISSING_DATABASE = '3D000'
const DUPLICATE_DATABASE = '42P04'

const {
  port,
  signal,
  config,
} = workerData as {
  port: MessagePort
  signal: Int32Array
  config: pg.ClientConfig & { database: string }
}

// A home's database appears on its first use, with the folded migration applied once.
async function connect(): Promise<pg.Client> {
  const client = new pg.Client(config)

  try {
    await client.connect()
  } catch (error) {
    if ((error as { code?: string }).code !== MISSING_DATABASE) {
      throw error
    }

    const admin = new pg.Client({
      ...config,
      database: 'postgres',
    })
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

  return client
}

const ready = connect()
// The main thread sees a failed connection on its next request, so the rejection is handled there.
ready.catch(() => undefined)

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

async function run({ request }: { request: Request }): Promise<Reply> {
  try {
    const client = await ready

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

      await client.query('commit')

      return { results }
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  } catch (error) {
    const failure = error as {
      message?: string
      code?: string
      constraint?: string
    }

    return {
      error: {
        message: failure.message ?? String(error),
        code: failure.code,
        constraint: failure.constraint,
      },
    }
  }
}

port.on(
  'message',
  async (request: Request) => {
    port.postMessage(await run({ request }))
    Atomics.store(
      signal,
      0,
      1,
    )
    Atomics.notify(
      signal,
      0,
    )
  },
)
