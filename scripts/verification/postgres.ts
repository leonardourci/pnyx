import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'

const USER = 'pnyx'
// Homebrew's keg on Apple silicon and Intel, then the Ubuntu packages GitHub's runners carry.
const HOMEBREW_BINS = [
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@17/bin',
]
const UBUNTU_ROOT = '/usr/lib/postgresql'

function binaries(): string {
  const ubuntu = existsSync(UBUNTU_ROOT)
    ? readdirSync(UBUNTU_ROOT).toSorted()
      .reverse()
      .map(version => join(
        UBUNTU_ROOT,
        version,
        'bin',
      ))
    : []
  const found = [
    ...HOMEBREW_BINS,
    ...ubuntu,
  ].find(bin => existsSync(join(
    bin,
    'initdb',
  )))

  if (!found) {
    throw new Error('Tests need PostgreSQL 15 or newer: run `brew install postgresql@17`')
  }

  return found
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

// A throwaway cluster for one test run, with the logical replication zero-cache needs. Each Pnyx home picks its
// own database in it from the returned libpq environment.
export async function startPostgres({ dir }: { dir: string }): Promise<{
  env: Record<'PGHOST' | 'PGPORT' | 'PGUSER', string>
  stop(): void
}> {
  const bin = binaries()
  const data = join(
    dir,
    'data',
  )
  const port = await freePort()
  // Postgres refuses to start under a locale it cannot load, as a test's bare environment has.
  const env = {
    ...process.env,
    LC_ALL: 'C',
  }
  execFileSync(
    join(
      bin,
      'initdb',
    ),
    [
      '--pgdata',
      data,
      '--username',
      USER,
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=C',
    ],
    {
      env,
      stdio: 'ignore',
    },
  )
  execFileSync(
    join(
      bin,
      'pg_ctl',
    ),
    [
      '--pgdata',
      data,
      '--log',
      join(
        dir,
        'postgres.log',
      ),
      '--wait',
      '-o',
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c wal_level=logical -c fsync=off -c max_connections=200`,
      'start',
    ],
    {
      env,
      stdio: 'ignore',
    },
  )

  return {
    env: {
      PGHOST: '127.0.0.1',
      PGPORT: String(port),
      PGUSER: USER,
    },
    stop: () => {
      spawnSync(
        join(
          bin,
          'pg_ctl',
        ),
        [
          '--pgdata',
          data,
          '--mode=immediate',
          'stop',
        ],
        {
          env,
          stdio: 'ignore',
        },
      )
    },
  }
}
