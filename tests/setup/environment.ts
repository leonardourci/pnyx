// Each test file's process: a scratch home, a guarded PATH, no inherited identity and a copy of the migrated template.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { afterAll, inject } from 'vitest'
import { closePostgres, homeDatabase } from '#store/postgres.ts'
import { keepFiles } from './keep.ts'

// Commands a test must never reach for real; each fails loudly instead.
const GUARDED = [
  'claude',
  'codex',
  'gh',
  'gh-axi',
  'paseo',
  'firstmate',
  'herdr',
  'tmux',
  'pnyx-axi',
  'quota-axi',
  'launchctl',
  'systemctl',
  'brew',
]
const KEEP = /^(VITEST|__VITEST|CI$|TERM$|FORCE_COLOR$|NO_COLOR$|PNYX_KEEP_TEST_FILES$)/

// Short paths leave room for the Unix socket names Pnyx makes inside its home.
const root = realpathSync(mkdtempSync('/tmp/pt-'))
const guards = join(
  root,
  'guards',
)
mkdirSync(guards)

for (const command of GUARDED) {
  writeFileSync(
    join(
      guards,
      command,
    ),
    `#!/bin/sh\necho "a test reached the real ${command}" >&2\nexit 79\n`,
    { mode: 0o755 },
  )
}

for (const key of Object.keys(process.env)) {
  if (!KEEP.test(key)) {
    delete process.env[key]
  }
}

Object.assign(
  process.env,
  {
    PATH: `${guards}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(
      root,
      'home',
    ),
    TMPDIR: join(
      root,
      'tmp',
    ),
    PNYX_HOME: join(
      root,
      'pnyx',
    ),
    CLAUDE_CONFIG_DIR: join(
      root,
      'claude',
    ),
    CODEX_HOME: join(
      root,
      'codex',
    ),
    PNYX_GH_AXI: 'false',
    // Every write checks that the rows it saved are all the rows its change touched.
    PNYX_CHECK_ROWS: '1',
    PNYX_PASEO_URL: 'ws://127.0.0.1:1/ws',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(
      root,
      'gitconfig',
    ),
    LANG: 'en_US.UTF-8',
    ...inject('postgres'),
  },
)

for (const key of [
  'HOME',
  'TMPDIR',
  'PNYX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
]) {
  mkdirSync(
    process.env[key]!,
    { recursive: true },
  )
}

const admin = new pg.Client({ database: 'postgres' })
await admin.connect()
await admin.query(`create database ${pg.escapeIdentifier(homeDatabase())} template ${pg.escapeIdentifier(inject('template'))} strategy file_copy`)
await admin.end()

// zero-cache leads its own process group, so a test process stopped from outside would leave it running.
const stopChildGroups = () => {
  const listing = spawnSync(
    '/bin/ps',
    [
      '-axo',
      'pid=,ppid=,pgid=',
    ],
    { encoding: 'utf8' },
  ).stdout

  for (const line of listing.split('\n')) {
    const [
      pid,
      parent,
      group,
    ] = line.trim().split(/\s+/)
      .map(Number)

    if (parent === process.pid && pid === group) {
      try {
        process.kill(
          -pid!,
          'SIGKILL',
        )
      } catch {
        // Already gone.
      }
    }
  }
}

process.once(
  'exit',
  stopChildGroups,
)

for (const signal of [
  'SIGINT',
  'SIGTERM',
] as const) {
  process.once(
    signal,
    () => {
      stopChildGroups()
      process.exit(1)
    },
  )
}

const removeRoot = () => rmSync(
  root,
  {
    recursive: true,
    force: true,
  },
)

afterAll(async () => {
  await closePostgres()
  keepFiles({ from: root })
  removeRoot()
  // The server's exit handler flushes its log into the home after this hook, so a listener added later removes it again.
  process.once(
    'exit',
    removeRoot,
  )
})
