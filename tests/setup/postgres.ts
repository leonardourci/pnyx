import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const USER = 'pnyx'
const MIN_VERSION = 15
const LOG_TAIL_LINES = 30
// Homebrew's kegs on Apple silicon and Intel, then the Ubuntu packages GitHub's runners carry.
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
export function binaries(): string {
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
    throw new Error(`Tests need PostgreSQL ${MIN_VERSION} or newer: \`brew install postgresql@17\` on macOS, \`sudo apt-get install postgresql\` on Ubuntu`)
  }

  return found.bin
}

export async function freePort(): Promise<number> {
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

// A throwaway cluster for one run, with the logical replication zero-cache needs and no durability.
export async function startPostgres({ dir }: { dir: string }) {
  const bin = binaries()
  const data = join(
    dir,
    'data',
  )
  const logFile = join(
    dir,
    'postgres.log',
  )
  const port = await freePort()
  // Postgres refuses a locale it cannot load, as a bare environment has.
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

    if (result.status !== 0) {
      const log = existsSync(logFile) ? readFileSync(
        logFile,
        'utf8',
      ).trimEnd()
        .split('\n')
        .slice(-LOG_TAIL_LINES)
        .join('\n') : 'none written'
      throw new Error(`${command} failed: ${result.stderr || result.error?.message}\nPostgres log:\n${log}`)
    }
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
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c wal_level=logical -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=400 -c max_replication_slots=40 -c max_wal_senders=40`,
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
