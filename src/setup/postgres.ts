import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { HydraError } from '#store/errors.ts'
import { configuredUrl, homeDatabase, query } from '#store/postgres.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { hydraExists, importLegacy } from '#app/store.ts'
import type { Output } from '#app/cli-support.ts'
import type { SetupItem } from './check.ts'
import { requireSetupHome } from './home.ts'

// zero-cache replicates through logical decoding, which Postgres has since 10; Zero itself needs 15.
const MIN_VERSION = 150_000
const FORMULA = 'postgresql@17'
const READY_MS = 30_000
const POLL_MS = 500
// How a connection fails when no Postgres listens, over TCP or a socket file; any other failure has a running server.
const NOT_RUNNING = /ECONNREFUSED|ENOENT|connection refused/i

interface Server {
  wal_level: string
  version: number
}

function server(): Server | HydraError {
  try {
    // Both settings always exist, so the one statement returns exactly one row.
    const row = query({
      statements: [
        {
          text: `select current_setting('wal_level') as wal_level,
            current_setting('server_version_num')::int as version`,
        },
      ],
    })[0]![0]!

    return {
      wal_level: String(row.wal_level),
      version: Number(row.version),
    }
  } catch (error) {
    if (!(error instanceof HydraError)) {
      throw error
    }

    return error
  }
}

const notRunning = ({ found }: { found: Server | HydraError }) =>
  found instanceof HydraError && NOT_RUNNING.test(found.message)

// The database Pnyx uses: the one the postgresUrl setting names, or this home's own.
function targetDatabase(): string {
  const url = configuredUrl()

  if (url === undefined) {
    return homeDatabase()
  }

  return new URL(url).pathname.slice(1)
}

function issueOf({ found }: { found: Server | HydraError }): SetupItem | undefined {
  const configured = configuredUrl() !== undefined
  const setup = 'pnyx-axi setup postgres'
  const fix = configured ? 'start the Postgres the postgresUrl setting names, with wal_level=logical' : setup

  if (found instanceof HydraError) {
    return {
      name: 'postgres',
      missing: `cannot reach Postgres for database ${targetDatabase()}: ${found.message}`,
      by: 'owner',
      fix,
    }
  }

  if (found.version < MIN_VERSION) {
    return {
      name: 'postgres',
      missing: `Postgres ${found.version} is older than 15, which Zero needs`,
      by: 'owner',
      fix: configured ? 'point postgresUrl at PostgreSQL 15 or newer' : `brew install ${FORMULA}, then ${setup}`,
    }
  }

  if (found.wal_level !== 'logical') {
    return {
      name: 'postgres',
      missing: `wal_level is ${found.wal_level}; zero-cache needs logical`,
      by: 'owner',
      fix,
    }
  }
}

// What keeps Pnyx's database from working, as a setup item, or undefined when Postgres is ready for it.
export const postgresIssue = () => issueOf({ found: server() })

function requireReady({ found }: { found: Server | HydraError }): Server {
  const issue = issueOf({ found })

  if (issue) {
    throw new HydraError({
      message: issue.missing,
      code: 'POSTGRES_UNAVAILABLE',
      help: [`Fix: ${issue.fix}`],
    })
  }

  // issueOf reports every failure, so what is left answered.
  return found as Server
}

function brewService({ action }: { action: 'start' | 'restart' }): void {
  const ran = spawnSync(
    'brew',
    [
      'services',
      action,
      FORMULA,
    ],
    {
      encoding: 'utf8',
      timeout: READY_MS * 2,
    },
  )

  if (ran.status === 0) {
    return
  }

  const reason = ran.error ? ran.error.message : ran.stderr

  throw new HydraError({
    message: `brew services ${action} ${FORMULA} failed: ${reason}`,
    code: 'POSTGRES_UNAVAILABLE',
    help: [`Run \`brew install ${FORMULA}\` if it is not installed`],
  })
}

// Waits for the Postgres Homebrew just started or restarted to accept connections.
async function started(): Promise<Server | HydraError> {
  const deadline = Date.now() + READY_MS
  let found = server()

  while (notRunning({ found }) && Date.now() < deadline) {
    await sleep(POLL_MS)
    found = server()
  }

  return found
}

const ready = ({ found }: { found: Server }) => ({
  postgres: 'ready',
  database: targetDatabase(),
  walLevel: found.wal_level,
  help: ['Run `pnyx-axi setup check` to see what else is missing'],
})

// Imports every Hydra still kept in an events.jsonl in a transaction it rolls back, the same way its first read would,
// without moving any folder, so an upgrade stops before its restart when an import would fail.
function checkImports(): Output {
  requireReady({ found: server() })
  const imported = hydraIds({ migrate: false })
    .filter(hydraId => !hydraExists({ hydraId }))
    .filter(hydraId => importLegacy({
      hydraId,
      dir: hydraDir({
        hydraId,
        migrate: false,
      }),
      trial: true,
    }))

  return {
    postgres: 'ready',
    database: targetDatabase(),
    imported: imported.length ? imported : 'none: no Hydra waiting',
  }
}

// Starts the Homebrew Postgres with the logical replication zero-cache needs, and its first query creates this home's
// database. A Postgres the postgresUrl setting names is only checked: Pnyx does not manage it.
export async function setupPostgres({
  check,
  allowCustomHome,
}: {
  check: boolean
  allowCustomHome: boolean
}): Promise<Output> {
  if (check) {
    return checkImports()
  }

  if (configuredUrl() !== undefined) {
    return ready({ found: requireReady({ found: server() }) })
  }

  // Homebrew's service serves every home on this machine.
  requireSetupHome({ allowCustomHome })
  let found = server()

  const issue = issueOf({ found })

  if (issue && process.platform !== 'darwin') {
    throw new HydraError({
      message: issue.missing,
      code: 'POSTGRES_UNAVAILABLE',
      help: ['Start PostgreSQL 15 or newer with wal_level=logical, then run `pnyx-axi setup check`'],
    })
  }

  if (notRunning({ found })) {
    brewService({ action: 'start' })
    found = await started()
  }

  const running = found instanceof HydraError ? undefined : found
  const needsLogical = running && running.version >= MIN_VERSION && running.wal_level !== 'logical'

  if (needsLogical) {
    query({ statements: [{ text: 'alter system set wal_level = \'logical\'' }] })
    brewService({ action: 'restart' })
    found = await started()
  }

  return ready({ found: requireReady({ found }) })
}
