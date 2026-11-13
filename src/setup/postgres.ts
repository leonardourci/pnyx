import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { HydraError } from '#store/errors.ts'
import { homeDatabase, query } from '#store/postgres.ts'
import { logPath } from '#store/storage.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { hydraExists } from '#app/store.ts'
import { readLog } from '#app/legacy-log.ts'
import { importHydra } from '#app/import.ts'
import type { Output } from '#app/cli-support.ts'
import type { SetupItem } from './check.ts'

// zero-cache replicates through logical decoding, which Postgres has since 10; Zero itself needs 15.
const MIN_VERSION = 150_000
const FORMULA = 'postgresql@17'
const READY_MS = 30_000
const POLL_MS = 500

interface Server {
  wal_level: string
  version: number
}

function server(): Server | Error {
  try {
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
    return error as Error
  }
}

// What keeps Pnyx's database from working, as a setup item, or undefined when Postgres is ready for it.
export function postgresIssue(): SetupItem | undefined {
  const found = server()
  const fix = 'pnyx-axi setup postgres'

  if (found instanceof Error) {
    return {
      name: 'postgres',
      missing: `cannot reach Postgres for database ${homeDatabase()}: ${found.message}`,
      by: 'owner',
      fix,
    }
  }

  if (found.version < MIN_VERSION) {
    return {
      name: 'postgres',
      missing: `Postgres ${found.version} is older than 15, which Zero needs`,
      by: 'owner',
      fix: `brew install ${FORMULA}, then ${fix}`,
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

const brew = ({ args }: { args: string[] }) => spawnSync(
  'brew',
  args,
  {
    encoding: 'utf8',
    timeout: READY_MS * 2,
  },
)

function brewService({ action }: { action: 'start' | 'restart' }): void {
  const ran = brew({
    args: [
      'services',
      action,
      FORMULA,
    ],
  })

  if (ran.status !== 0) {
    throw new HydraError({
      message: `brew services ${action} ${FORMULA} failed: ${ran.stderr || ran.error?.message}`,
      code: 'POSTGRES_UNAVAILABLE',
      help: [`Run \`brew install ${FORMULA}\` if it is not installed`],
    })
  }
}

async function reachable(): Promise<Server> {
  const deadline = Date.now() + READY_MS
  let found = server()

  while (found instanceof Error && Date.now() < deadline) {
    await sleep(POLL_MS)
    found = server()
  }

  if (found instanceof Error) {
    throw new HydraError({
      message: `Postgres did not answer within ${READY_MS / 1000}s: ${found.message}`,
      code: 'POSTGRES_UNAVAILABLE',
      help: [`Run \`brew services info ${FORMULA}\` to see why it is not running`],
    })
  }

  return found
}

// The Hydras whose events.jsonl has not moved into Postgres yet.
const waitingHydras = () => hydraIds().filter(hydraId => !hydraExists({ hydraId })
  && existsSync(logPath({ dir: hydraDir({ hydraId }) })))

// Starts the Homebrew Postgres with the logical replication zero-cache needs and creates this home's database. With
// check, it changes nothing: it reports what is missing and imports every waiting Hydra in a transaction it rolls back,
// so an upgrade stops before its restart when an import would fail.
export async function setupPostgres({ check }: { check: boolean }): Promise<Output> {
  const issue = postgresIssue()

  if (check) {
    if (issue) {
      throw new HydraError({
        message: issue.missing,
        code: 'POSTGRES_UNAVAILABLE',
        help: [`Run \`${issue.fix}\``],
      })
    }

    const waiting = waitingHydras()

    for (const hydraId of waiting) {
      const log = readLog({ dir: hydraDir({ hydraId }) })
      importHydra({
        hydraId,
        events: log?.events ?? [],
        transactions: log?.transactions,
        trial: true,
      })
    }

    return {
      postgres: 'ready',
      database: homeDatabase(),
      imports: waiting.length ? `${waiting.length} Hydras import cleanly: ${waiting.join(', ')}` : 'none waiting',
    }
  }

  if (issue && process.platform !== 'darwin') {
    throw new HydraError({
      message: issue.missing,
      code: 'POSTGRES_UNAVAILABLE',
      help: ['Start PostgreSQL 15 or newer with wal_level=logical, then run `pnyx-axi setup check`'],
    })
  }

  if (server() instanceof Error) {
    brewService({ action: 'start' })
  }

  if ((await reachable()).wal_level !== 'logical') {
    query({ statements: [{ text: 'alter system set wal_level = \'logical\'' }] })
    brewService({ action: 'restart' })
  }

  const ready = await reachable()

  if (ready.wal_level !== 'logical' || ready.version < MIN_VERSION) {
    throw new HydraError({
      message: postgresIssue()?.missing ?? 'Postgres is not ready',
      code: 'POSTGRES_UNAVAILABLE',
    })
  }

  return {
    postgres: 'ready',
    database: homeDatabase(),
    walLevel: ready.wal_level,
    help: ['Run `pnyx-axi setup check` to see what else is missing'],
  }
}
