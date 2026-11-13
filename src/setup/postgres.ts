import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HydraError } from '#store/errors.ts'
import { closePostgres, configuredUrl, homeDatabase, query } from '#store/postgres.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { hydraExists, importLegacy, loadHydra } from '#app/store.ts'
import { recordExitCode } from '#app/request-context.ts'
import type { Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { saveSettings, shownSettings } from '#settings/store.ts'
import type { SetupItem } from './check.ts'
import { requireSetupHome } from './home.ts'

// zero-cache replicates through logical decoding, which Postgres has since 10; Zero itself needs 15.
const MIN_VERSION = 150_000
// server_version_num holds the major version times 10000.
const MAJOR_FACTOR = 10_000
const FORMULA = 'postgresql@17'
const READY_MS = 30_000
// The most WAL a replication slot keeps for a zero-cache that stopped; past it Postgres invalidates the slot and zero-cache
// syncs again on its next start.
const MAX_SLOT_WAL = '4GB'
const POLL_MS = 500
// How a connection fails when no Postgres listens, over TCP or a socket file; any other failure has a running server.
const NOT_RUNNING = /ECONNREFUSED|ENOENT|connection refused/i
// A server that is starting, or restarting and dropped the connection, answers once it is up.
const STARTING = /the database system is starting up|Connection terminated unexpectedly/i
// Postgres refused the role or its password, which no start or restart changes.
const SIGN_IN_REFUSED = /role ".*" does not exist|password authentication failed|no pg_hba\.conf entry/i
const SETUP = 'pnyx-axi setup postgres'
const CHANGE_URL = 'save a corrected URL with `pnyx-axi setup postgres --url <url>`, or clear it with `pnyx-axi setup postgres --url \'\'`, then run `pnyx-axi restart`'
const MANUAL_START = 'start PostgreSQL 15 or newer with wal_level=logical where PGHOST and PGPORT point, then run `pnyx-axi setup check`'

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

const starting = ({ found }: { found: Server | HydraError }) =>
  found instanceof HydraError && STARTING.test(found.message)

const onMac = () => process.platform === 'darwin'

// The database Pnyx uses: the one the postgresUrl setting names, or this home's own.
function targetDatabase(): string {
  const url = configuredUrl()

  if (url === undefined) {
    return homeDatabase()
  }

  return new URL(url).pathname.slice(1)
}

function unreachableFix({ error }: { error: HydraError }): string {
  const configured = configuredUrl() !== undefined
  const refused = SIGN_IN_REFUSED.test(error.message)

  if (configured && refused) {
    return `correct the role or password in the postgresUrl setting: ${CHANGE_URL}`
  }

  if (configured) {
    return `start the Postgres the postgresUrl setting names, with wal_level=logical, or ${CHANGE_URL}`
  }

  if (refused) {
    return 'create the role PGUSER names (your login name when unset) on this Postgres, set PGUSER and PGPASSWORD to one that signs in, or save a postgresUrl with `pnyx-axi setup postgres --url <url>`'
  }

  return onMac() ? SETUP : MANUAL_START
}

function unreachable({ error }: { error: HydraError }): SetupItem {
  return {
    name: 'postgres',
    missing: `cannot reach Postgres for database ${targetDatabase()}: ${error.message}`,
    by: 'owner',
    fix: unreachableFix({ error }),
  }
}

function oldVersionFix({ major }: { major: number }): string {
  if (configuredUrl() !== undefined) {
    return 'point postgresUrl at PostgreSQL 15 or newer'
  }

  if (!onMac()) {
    return `stop Postgres ${major}, then ${MANUAL_START}`
  }

  return `stop Postgres ${major} first, since ${FORMULA} cannot take its port while it runs, then run \`brew install ${FORMULA}\` and \`${SETUP}\``
}

function walLevelFix(): string {
  if (configuredUrl() !== undefined) {
    return 'set wal_level=logical on the Postgres the postgresUrl setting names, then restart it'
  }

  return onMac() ? SETUP : 'run `alter system set wal_level = logical` on this Postgres, restart it, then run `pnyx-axi setup check`'
}

function serverIssue({ found }: { found: Server }): SetupItem | undefined {
  if (found.version < MIN_VERSION) {
    const major = Math.floor(found.version / MAJOR_FACTOR)

    return {
      name: 'postgres',
      missing: `Postgres ${major} is older than 15, which Zero needs`,
      by: 'owner',
      fix: oldVersionFix({ major }),
    }
  }

  if (found.wal_level !== 'logical') {
    return {
      name: 'postgres',
      missing: `wal_level is ${found.wal_level}; zero-cache needs logical`,
      by: 'owner',
      fix: walLevelFix(),
    }
  }
}

const issueOf = ({ found }: { found: Server | HydraError }) => found instanceof HydraError
  ? unreachable({ error: found })
  : serverIssue({ found })

// What keeps Pnyx's database from working, as a setup item, or undefined when Postgres is ready for it.
export const postgresIssue = () => issueOf({ found: server() })

const unavailable = ({ issue }: { issue: SetupItem }) => new HydraError({
  message: issue.missing,
  code: 'POSTGRES_UNAVAILABLE',
  help: [`Fix: ${issue.fix}`],
})

function requireReady({ found }: { found: Server | HydraError }): Server {
  if (found instanceof HydraError) {
    throw unavailable({ issue: unreachable({ error: found }) })
  }

  const issue = serverIssue({ found })

  if (issue) {
    throw unavailable({ issue })
  }

  return found
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

// Only Homebrew's own postgresql@17 is changed and restarted; a Postgres.app, Docker or other Homebrew version that
// answers on the same port is the owner's to configure.
function requireHomebrewData(): void {
  const prefix = spawnSync(
    'brew',
    ['--prefix'],
    { encoding: 'utf8' },
  )
  const expected = prefix.status === 0 ? join(
    prefix.stdout.trim(),
    'var',
    FORMULA,
  ) : undefined
  const actual = String(query({ statements: [{ text: 'select current_setting(\'data_directory\') as dir' }] })[0]![0]!.dir)

  if (expected !== undefined && resolve(actual) === resolve(expected)) {
    return
  }

  throw new HydraError({
    message: `the Postgres answering keeps its data in ${actual}, not in Homebrew's ${FORMULA}, so Pnyx leaves its settings alone`,
    code: 'POSTGRES_UNAVAILABLE',
    help: ['Fix: run `alter system set wal_level = logical` on that Postgres, restart it, then run `pnyx-axi setup check`'],
  })
}

// Waits for the Postgres Homebrew just started or restarted to accept connections.
async function started(): Promise<Server | HydraError> {
  const deadline = Date.now() + READY_MS
  let found = server()

  while ((notRunning({ found }) || starting({ found })) && Date.now() < deadline) {
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

// Imports every Hydra still kept in an events.jsonl in a transaction it rolls back, the same way the server would,
// without moving any folder, and reads every imported one, which refuses a log an older Pnyx appended to since. An
// upgrade stops before its restart when any Hydra fails; each failure names its Hydra.
function checkImports(): Output {
  requireReady({ found: server() })
  const imported: string[] = []
  const failed: {
    hydra: string
    error: string
  }[] = []

  for (const hydraId of hydraIds({ migrate: false })) {
    try {
      if (hydraExists({ hydraId })) {
        loadHydra({
          hydraId,
          migrate: false,
        })
      } else if (importLegacy({
        hydraId,
        dir: hydraDir({
          hydraId,
          migrate: false,
        }),
        trial: true,
      })) {
        imported.push(hydraId)
      }
    } catch (error) {
      if (!(error instanceof HydraError)) {
        throw error
      }

      failed.push({
        hydra: hydraId,
        error: error.message,
      })
    }
  }

  const checked = {
    postgres: 'ready',
    database: targetDatabase(),
    imported: imported.length ? imported : 'none: no Hydra waiting',
  }

  if (!failed.length) {
    return checked
  }

  recordExitCode({ code: 1 })

  return {
    ...checked,
    failed,
  }
}

// Saves postgresUrl straight into the settings log, without the server, which cannot start while the URL is wrong.
function saveUrl({
  url,
  meta,
}: {
  url: string
  meta: Meta
}): Output {
  const saved = saveSettings({
    patch: { postgresUrl: url },
    meta,
  })
  const shown = shownSettings({ settings: saved.settings }).postgresUrl

  return {
    postgresUrl: shown === '' ? 'none: this home\'s own database through PGHOST, PGPORT and PGUSER' : shown,
    help: ['The server uses it from its next start: run `pnyx-axi restart`'],
  }
}

// Starts the Homebrew Postgres with the logical replication zero-cache needs, and its first query creates this home's
// database. A Postgres the postgresUrl setting names is only checked: Pnyx does not manage it.
export async function setupPostgres({
  check,
  allowCustomHome,
  url,
  meta,
}: {
  check: boolean
  allowCustomHome: boolean
  url?: string
  meta: Meta
}): Promise<Output> {
  if (url !== undefined) {
    return saveUrl({
      url,
      meta,
    })
  }

  if (check) {
    return checkImports()
  }

  if (configuredUrl() !== undefined) {
    return ready({ found: requireReady({ found: server() }) })
  }

  let found = server()
  const issue = issueOf({ found })

  if (issue && !onMac()) {
    throw unavailable({ issue })
  }

  if (notRunning({ found })) {
    // Homebrew's service serves every home on this machine.
    requireSetupHome({ allowCustomHome })
    brewService({ action: 'start' })
    found = await started()
  }

  const running = found instanceof HydraError ? undefined : found
  const needsLogical = running && running.version >= MIN_VERSION && running.wal_level !== 'logical'

  if (!needsLogical) {
    return ready({ found: requireReady({ found }) })
  }

  requireSetupHome({ allowCustomHome })
  requireHomebrewData()
  query({
    statements: [
      { text: 'alter system set wal_level = \'logical\'' },
      // A stopped server's replication slot would otherwise keep every WAL file of the cluster from then on.
      { text: `alter system set max_slot_wal_keep_size = '${MAX_SLOT_WAL}'` },
    ],
  })
  await closePostgres()
  brewService({ action: 'restart' })
  const restarted = await started()
  // The restart reached another server than the one that took the setting, such as a Postgres not from Homebrew.
  const stillReplica = !(restarted instanceof HydraError) && restarted.wal_level !== 'logical'

  if (stillReplica) {
    throw new HydraError({
      message: `wal_level is still ${restarted.wal_level} after restarting ${FORMULA}`,
      code: 'POSTGRES_UNAVAILABLE',
      help: ['Fix: wal_level=logical is set; restart your Postgres to apply it'],
    })
  }

  return ready({ found: requireReady({ found: restarted }) })
}
