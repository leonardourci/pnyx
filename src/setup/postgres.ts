import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { HydraError } from '#store/errors.ts'
import { closePostgres, configuredUrl, homeDatabase, migrateSchema, query, useConfiguredDatabase, useDatabase } from '#store/postgres.ts'
import { SCHEMA_VERSION } from '#store/schema.ts'
import type { Output } from '#app/cli-support.ts'
import type { Meta } from '#app/command-meta.ts'
import { saveSettings, shownSettings } from '#settings/store.ts'
import type { SetupItem } from './check.ts'
import { requireSetupHome } from './home.ts'

const MIN_VERSION = 150_000
// server_version_num holds the major version times 10000.
const MAJOR_FACTOR = 10_000
const FORMULA = 'postgresql@17'
const READY_MS = 30_000
const POLL_MS = 500
// The data check's disposable copy of the database, beside it on the same server.
const COPY_SUFFIX = '_upgrade_check'
const COPY_MS = 10 * 60_000
const BREW_PREFIX_MS = 30_000
// How a connection fails when no Postgres listens, over TCP or a socket file; any other failure has a running server.
const NOT_RUNNING = /ECONNREFUSED|ENOENT|connection refused/i
// A server that is starting, or restarting and dropped the connection, answers once it is up.
const STARTING = /the database system is starting up|Connection terminated unexpectedly/i
// Postgres refused the role or its password, which no start or restart changes.
const SIGN_IN_REFUSED = /role ".*" does not exist|password authentication failed|no pg_hba\.conf entry/i
const SETUP = 'pnyx setup postgres'
const CHANGE_URL = 'save a corrected URL with `pnyx setup postgres --url <url>`, or clear it with `pnyx setup postgres --url \'\'`, then restart the Pnyx login service (or stop and rerun `pnyx serve`)'
const MANUAL_START = 'start PostgreSQL 15 or newer where PGHOST and PGPORT point, then run `pnyx setup check`'

interface Server {
  version: number
}

function server(): Server | HydraError {
  try {
    const row = query({
      schema: 'inspect',
      statements: [
        {
          text: 'select current_setting(\'server_version_num\')::int as version',
        },
      ],
    })[0]![0]!

    return {
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
    return `start the Postgres the postgresUrl setting names, or ${CHANGE_URL}`
  }

  if (refused) {
    return 'create the role PGUSER names (your login name when unset) on this Postgres, set PGUSER and PGPASSWORD to one that signs in, or save a postgresUrl with `pnyx setup postgres --url <url>`'
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

function serverIssue({ found }: { found: Server }): SetupItem | undefined {
  if (found.version < MIN_VERSION) {
    const major = Math.floor(found.version / MAJOR_FACTOR)

    return {
      name: 'postgres',
      missing: `Postgres ${major} is older than the supported version 15`,
      by: 'owner',
      fix: oldVersionFix({ major }),
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

function brewService({ action }: { action: 'start' }): void {
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

async function started(): Promise<Server | HydraError> {
  const deadline = Date.now() + READY_MS
  let found = server()

  while ((notRunning({ found }) || starting({ found })) && Date.now() < deadline) {
    await sleep(POLL_MS)
    found = server()
  }

  return found
}

const ready = () => ({
  postgres: 'ready',
  database: targetDatabase(),
  help: ['Run `pnyx setup check` to see what else is missing'],
})

// Homebrew installs postgresql@17 keg-only, so its pg_dump and pg_restore are not on PATH unless the owner put them
// there; they are searched after PATH's own.
function copyEnv(): NodeJS.ProcessEnv {
  const prefix = spawnSync(
    'brew',
    [
      '--prefix',
      FORMULA,
    ],
    {
      encoding: 'utf8',
      timeout: BREW_PREFIX_MS,
    },
  )

  if (prefix.status !== 0) {
    return process.env
  }

  const kegBin = join(
    prefix.stdout.trim(),
    'bin',
  )

  return {
    ...process.env,
    PATH: `${process.env.PATH}${delimiter}${kegBin}`,
  }
}

function copyTool({
  command,
  args,
  env,
}: {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}): void {
  const ran = spawnSync(
    command,
    args,
    {
      encoding: 'utf8',
      timeout: COPY_MS,
      env,
    },
  )

  if (ran.status === 0) {
    return
  }

  throw new HydraError({
    message: `${command} could not copy the database for the data check: ${ran.error ? ran.error.message : ran.stderr}`,
    code: 'POSTGRES_UNAVAILABLE',
    help: [`Fix: put the pg_dump and pg_restore of this Postgres's version or newer on PATH (Homebrew's ${FORMULA} is found without it), then run \`pnyx setup postgres --check\``],
  })
}

// pg_dump copies the database while the old server holds it, which CREATE DATABASE ... TEMPLATE refuses.
async function checkOnCopy({
  database,
  version,
}: {
  database: string
  version: number
}): Promise<Output> {
  const name = `${database}${COPY_SUFFIX}`
  const live = new URL(configuredUrl() ?? `postgresql:///${database}`)
  const copy = new URL(live)
  copy.pathname = `/${name}`
  const drop = { text: `drop database if exists ${pg.escapeIdentifier(name)} with (force)` }
  const dumpDir = mkdtempSync(join(
    tmpdir(),
    'pnyx-check-',
  ))
  const dump = join(
    dumpDir,
    'pnyx.dump',
  )
  const env = copyEnv()

  try {
    query({
      schema: 'inspect',
      statements: [
        drop,
        { text: `create database ${pg.escapeIdentifier(name)}` },
      ],
    })
    copyTool({
      command: 'pg_dump',
      args: [
        '--format=custom',
        `--file=${dump}`,
        `--dbname=${live.href}`,
      ],
      env,
    })
    copyTool({
      command: 'pg_restore',
      args: [
        '--exit-on-error',
        '--no-owner',
        `--dbname=${copy.href}`,
        dump,
      ],
      env,
    })
    useDatabase({ url: copy.href })

    try {
      migrateSchema()
    } catch (error) {
      if (!(error instanceof HydraError)) {
        throw error
      }

      throw new HydraError({
        message: `a copy of database ${database} at schema ${version} did not migrate to schema ${SCHEMA_VERSION}: ${error.message}`,
        code: error.code,
        cause: error,
      })
    }

    return {
      schema: version,
      migration: `checked on a copy: serve migrates schema ${version} to ${SCHEMA_VERSION} when it starts`,
    }
  } finally {
    rmSync(
      dumpDir,
      {
        recursive: true,
        force: true,
      },
    )
    await closePostgres()
    useConfiguredDatabase()
    query({
      schema: 'inspect',
      statements: [drop],
    })
  }
}

async function checkData(): Promise<Output> {
  requireReady({ found: server() })
  const database = targetDatabase()
  const [tables] = query({
    schema: 'inspect',
    statements: [{ text: 'select to_regclass(\'public.schema_version\') as name' }],
  })

  if (!tables?.[0]?.name) {
    return {
      postgres: 'ready',
      database,
      migration: 'pending: serve creates the database',
    }
  }

  const [versions] = query({
    schema: 'inspect',
    statements: [{ text: 'select max(version)::integer as version from schema_version' }],
  })
  const version = Number(versions?.[0]?.version)
  const checked = version === SCHEMA_VERSION ? { schema: version } : await checkOnCopy({
    database,
    version,
  })

  return {
    postgres: 'ready',
    database,
    ...checked,
  }
}

// Saves postgresUrl straight into the settings log, without the server, which cannot start while the URL is wrong.
async function saveUrl({
  url,
  meta,
}: {
  url: string
  meta: Meta
}): Promise<Output> {
  const saved = await saveSettings({
    patch: { postgresUrl: url },
    meta,
  })
  const shown = shownSettings({ settings: saved.settings }).postgresUrl

  return {
    postgresUrl: shown === '' ? 'none: this home\'s own database through PGHOST, PGPORT and PGUSER' : shown,
    help: ['Restart the Pnyx login service or stop and rerun `pnyx serve` to use this setting'],
  }
}

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
    return await saveUrl({
      url,
      meta,
    })
  }

  if (check) {
    return checkData()
  }

  if (configuredUrl() !== undefined) {
    requireReady({ found: server() })

    return ready()
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

  requireReady({ found })

  return ready()
}
