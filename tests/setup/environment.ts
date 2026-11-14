// Each test file's process: a scratch home, a guarded PATH, no inherited identity and a copy of the migrated template.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { afterAll, inject } from 'vitest'
import { closePostgres, homeDatabase } from '#store/postgres.ts'

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
const KEEP = /^(VITEST|__VITEST|CI$|TERM$|FORCE_COLOR$|NO_COLOR$)/

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

afterAll(async () => {
  await closePostgres()
  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
})
