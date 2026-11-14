import { readFileSync } from 'node:fs'
import { workerData, type MessagePort } from 'node:worker_threads'
import pg from 'pg'
import { errorDetails } from './error-details.ts'
import { CONFLICT_CODE } from './errors.ts'
import type { Outcome, Reply, Request, Statement } from './postgres.ts'

const MISSING_DATABASE = '3D000'
// Two processes opening a new home at once migrate it once, under this advisory lock.
const SCHEMA_LOCK = 'select pg_advisory_lock(hashtext(\'pnyx schema\'))'
const SCHEMA_UNLOCK = 'select pg_advisory_unlock(hashtext(\'pnyx schema\'))'
const DUPLICATE_DATABASE = '42P04'
// Not a Postgres code: a database whose schema this build did not make.
const SCHEMA_MISMATCH = 'PNYX_SCHEMA'
// Postgres cancels a statement, or its wait for a lock, after these, so a lock another session holds or a slow
// statement answers the server with an error instead of freezing it for its whole wait.
const STATEMENT_TIMEOUT_MS = 10_000
const LOCK_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 5_000
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
const limits = {
  statement_timeout: STATEMENT_TIMEOUT_MS,
  lock_timeout: LOCK_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
}

// The same server's maintenance database, which can create this one; a connection string names its database itself.
function adminConfig(): pg.ClientConfig {
  if (!config.connectionString) {
    return {
      ...config,
      ...limits,
      database: 'postgres',
    }
  }

  const url = new URL(config.connectionString)
  url.pathname = '/postgres'

  return {
    ...limits,
    connectionString: url.href,
  }
}

const SCHEMA = readFileSync(
  new URL(
    './schema.sql',
    import.meta.url,
  ),
  'utf8',
)
// The page's publication as schema.sql creates it, which a migration sets an older database's to.
const PAGE_PUBLICATION = /create publication pnyx_page for table[^;]*/.exec(SCHEMA)?.[0] ?? ''

if (!PAGE_PUBLICATION) {
  throw new Error('schema.sql has no pnyx_page publication')
}

// schema.sql names its own version, so the number has one source.
const SCHEMA_VERSION = Number(/insert into schema_version \(version\) values \((\d+)\)/.exec(SCHEMA)?.[1])

// A database another build's schema made would fail writes this build's statements make, so it is refused by name.
async function requireSchema({
  client,
  migrate = false,
}: {
  client: pg.Client
  migrate?: boolean
}): Promise<void> {
  const versioned = await client.query<{ table: string | null }>('select to_regclass(\'public.schema_version\') as table')
  const versions = versioned.rows[0]?.table
    ? (await client.query<{ version: number }>('select version from schema_version')).rows
    : []

  const current = Math.max(
    0,
    ...versions.map(row => row.version),
  )

  if (current === SCHEMA_VERSION) {
    return
  }

  if (current === 1 && migrate) {
    await client.query('begin')

    try {
      await client.query(`set local statement_timeout = 0;
        set local lock_timeout = 0;
        create index card_updates_event on card_updates (hydra_id, seq);
        insert into hydra_values (hydra_id, key, value) select id, 'queue', queue from hydras
          on conflict (hydra_id, key) do nothing`)
      await client.query(`create table source_observations (
        hydra_id text not null references hydras (id) on delete cascade,
        card_id text not null, adapter text not null, instance_id text not null,
        object_id text not null, generation double precision not null check (generation >= 0),
        observed_at text not null, seen_at text not null,
        primary key (hydra_id, card_id, adapter, instance_id, object_id)
      );
      insert into source_observations
        (hydra_id, card_id, adapter, instance_id, object_id, generation, observed_at, seen_at)
      select distinct on (hydra_id, card_id, source->>'adapter', coalesce(source->>'instanceId', ''), source->>'objectId')
        hydra_id, card_id, source->>'adapter', coalesce(source->>'instanceId', ''), source->>'objectId',
        coalesce((source->>'generation')::double precision, 0), coalesce(source->>'observedAt', at), at
      from (select hydra_id, card_id, at, seq, data->'data'->'source' as source from events
        where type in ('card.pushed', 'card.observed')) candidates
      where source->>'adapter' is not null and source->>'objectId' is not null
      order by hydra_id, card_id, source->>'adapter', coalesce(source->>'instanceId', ''), source->>'objectId',
        coalesce((source->>'generation')::double precision, 0) desc, coalesce(source->>'observedAt', at) desc, seq desc;
      `)
      await client.query(`with removed as (
        delete from events where type in ('card.observed', 'chat.message') returning hydra_id
      ) select hydra_id, count(*)::integer as count from removed group by hydra_id`)
      await client.query(`create index events_card_history on events (hydra_id, card_id, seq);
        create index events_type_history on events (hydra_id, type, seq)`)

      // The page reads no events, and Hydra's chat reads the actions within the time its page spans.
      await client.query(`create index events_at on events (hydra_id, at);
        ${PAGE_PUBLICATION.replace(
          'create publication pnyx_page for table',
          'alter publication pnyx_page set table',
        )};
        insert into schema_version (version) values (5)`)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    }

    return
  }

  throw Object.assign(
    new Error(`database ${config.database} has another Pnyx build's schema (${current}); this build requires ${SCHEMA_VERSION}. Start this build with serve to migrate an older schema; this build cannot use it. A database made before the first release can be dropped (\`dropdb ${config.database}\`), and the server imports every Hydra's events.jsonl again`),
    { code: SCHEMA_MISMATCH },
  )
}

// A home's database appears on its first use, with the folded migration applied once.
async function connect({ schema }: { schema?: Request['schema'] }): Promise<pg.Client> {
  const client = new pg.Client({
    ...config,
    ...limits,
  })

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
    await client.end()

    if ((error as { code?: string }).code !== MISSING_DATABASE) {
      throw error
    }

    const admin = new pg.Client(adminConfig())
    await admin.connect()

    if (schema === 'inspect') {
      return admin
    }

    try {
      await admin.query(`create database ${pg.escapeIdentifier(config.database)}`)
    } catch (createError) {
      if ((createError as { code?: string }).code !== DUPLICATE_DATABASE) {
        throw createError
      }
    } finally {
      await admin.end()
    }

    return connect({ schema })
  }

  try {
    if (schema === 'inspect') {
      return client
    }

    await client.query('set lock_timeout = 0')
    await client.query(SCHEMA_LOCK)

    try {
      const { rows } = await client.query<{ table: string | null }>('select to_regclass(\'public.hydras\') as table')

      if (!rows[0]?.table) {
      // One query, so the tables and their version commit together.
        await client.query(SCHEMA)
      } else {
        await requireSchema({
          client,
          migrate: schema === 'migrate',
        })
      }
    } finally {
      await client.query(SCHEMA_UNLOCK)
      await client.query(`set lock_timeout = ${LOCK_TIMEOUT_MS}`)
    }
  } catch (error) {
    await client.end()
    throw error
  }

  return client
}

let ready: Promise<pg.Client> | undefined
let inspected = false

// A connection that failed to open is tried again on the next request, so Pnyx recovers once Postgres is up.
async function connection({ schema }: { schema?: Request['schema'] }): Promise<pg.Client> {
  if (ready && inspected && schema !== 'inspect') {
    const client = await ready
    await client.end()
    ready = undefined
  }

  inspected = schema === 'inspect'
  const opening = ready ?? connect({ schema })
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

  Atomics.add(
    signal,
    1,
    1,
  )

  return result.rows
}

async function run({ request }: { request: Request }): Promise<Outcome> {
  try {
    const connecting = performance.now()
    const client = await connection({ schema: request.schema })
    const connectionWaitMs = performance.now() - connecting

    if (!request.transaction) {
      const results = []

      for (const statement of request.statements) {
        results.push(await execute({
          client,
          statement,
        }))
      }

      return {
        results,
        timings: {
          connectionWaitMs,
          commitMs: 0,
        },
      }
    }

    await client.query('begin')

    try {
      if (request.statementTimeoutMs !== undefined) {
        await client.query(`set local statement_timeout = ${Math.trunc(request.statementTimeoutMs)}`)
      }

      const results = []

      for (const statement of request.statements) {
        results.push(await execute({
          client,
          statement,
        }))
      }

      const committing = performance.now()
      await client.query(request.rollback ? 'rollback' : 'commit')

      return {
        results,
        timings: {
          connectionWaitMs,
          commitMs: performance.now() - committing,
        },
      }
    } catch (error) {
      // A lost connection fails the rollback too; the caller needs the error that stopped the transaction.
      await client.query('rollback').catch(() => undefined)
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
      error: errorDetails({ error }),
    }
  }
}

const answer = ({ reply }: { reply: Reply }) => {
  port.postMessage(reply)
  Atomics.store(
    signal,
    0,
    1,
  )
  Atomics.notify(
    signal,
    0,
  )
}

// One request at a time on the one connection, so no request's statements land inside another's transaction.
let running = Promise.resolve()
let current: number | undefined

const serve = async ({
  previous,
  request,
}: {
  previous: Promise<void>
  request: Request
}) => {
  await previous
  current = request.id
  const outcome = await run({ request })
  answer({
    reply: {
      id: request.id,
      ...outcome,
    },
  })
  current = undefined
}

port.on(
  'message',
  (request: Request) => {
    running = serve({
      previous: running,
      request,
    })
  },
)

// An error that escapes a request answers it at once, instead of leaving the server waiting out its timeout.
process.on(
  'uncaughtException',
  error => {
    if (current !== undefined) {
      answer({
        reply: {
          id: current,
          error: errorDetails({ error }),
        },
      })
    }

    process.exit(1)
  },
)
