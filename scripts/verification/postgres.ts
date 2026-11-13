import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'

const USER = 'pnyx'
const MIN_VERSION = 15
// The launcher deletes the cluster's folder on exit, so a failure carries the end of its log.
export const POSTGRES_LOG_TAIL_LINES = 20
// Homebrew's versioned kegs on Apple silicon and Intel, then the Ubuntu packages GitHub's runners carry.
const ROOTS = [
  {
    dir: '/opt/homebrew/opt',
    version: /^postgresql@(\d+)$/,
  },
  {
    dir: '/usr/local/opt',
    version: /^postgresql@(\d+)$/,
  },
  {
    dir: '/usr/lib/postgresql',
    version: /^(\d+)$/,
  },
]

// The newest installed PostgreSQL that zero-cache supports.
function binaries(): string {
  const found = ROOTS.flatMap(root => existsSync(root.dir)
    ? readdirSync(root.dir).flatMap(name => {
      const version = Number(root.version.exec(name)?.[1])
      const bin = join(
        root.dir,
        name,
        'bin',
      )

      return version >= MIN_VERSION && existsSync(join(
        bin,
        'initdb',
      )) ? [
          {
            version,
            bin,
          },
        ] : []
    })
    : [])
    .toSorted((
      a,
      b,
    ) => b.version - a.version)[0]

  if (!found) {
    throw new Error(`Tests need PostgreSQL ${MIN_VERSION} or newer: run \`brew install postgresql@17\` on macOS or \`sudo apt-get install postgresql\` on Ubuntu`)
  }

  return found.bin
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(
    0,
    '127.0.0.1',
    resolve,
  ))
  const address = server.address()
  await new Promise(resolve => server.close(resolve))

  if (!address || typeof address === 'string') {
    throw new Error('no free port')
  }

  return address.port
}

// A throwaway cluster for one test run, with the logical replication zero-cache needs.
export async function startPostgres({ dir }: { dir: string }): Promise<{
  env: Record<'PGHOST' | 'PGPORT' | 'PGUSER', string>
  logFile: string
  stop(): void
}> {
  const bin = binaries()
  const data = join(
    dir,
    'data',
  )
  const port = await freePort()
  const logFile = join(
    dir,
    'postgres.log',
  )
  // Postgres refuses to start under a locale it cannot load, as a test's bare environment has.
  const env = {
    ...process.env,
    LC_ALL: 'C',
  }

  const run = ({
    command,
    args,
  }: {
    command: string
    args: string[]
  }) => {
    const result = spawnSync(
      join(
        bin,
        command,
      ),
      args,
      {
        env,
        encoding: 'utf8',
      },
    )

    if (result.status === 0) {
      return
    }

    const log = existsSync(logFile)
      ? readFileSync(
        logFile,
        'utf8',
      ).trimEnd()
        .split('\n')
        .slice(-POSTGRES_LOG_TAIL_LINES)
        .join('\n')
      : 'none written'

    throw new Error(`${command} failed: ${result.stderr || result.error?.message}\nPostgres log:\n${log}`)
  }

  run({
    command: 'initdb',
    args: [
      '--pgdata',
      data,
      '--username',
      USER,
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=C',
    ],
  })
  run({
    command: 'pg_ctl',
    args: [
      '--pgdata',
      data,
      '--log',
      logFile,
      '--wait',
      '-o',
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c wal_level=logical -c fsync=off -c max_connections=200 -c log_lock_waits=on -c log_parameter_max_length_on_error=0`,
      'start',
    ],
  })

  return {
    logFile,
    env: {
      PGHOST: '127.0.0.1',
      PGPORT: String(port),
      PGUSER: USER,
    },
    stop: () => run({
      command: 'pg_ctl',
      args: [
        '--pgdata',
        data,
        '--mode=immediate',
        'stop',
      ],
    }),
  }
}
