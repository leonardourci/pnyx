// Each test file's process: a scratch home, a guarded PATH, no inherited identity and a copy of the migrated template.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, inject } from 'vitest'
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
  'pnyx',
  'quota-axi',
  'launchctl',
  'systemctl',
  'brew',
]
const CHILD_HEAP_MB = 1024
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
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(
      root,
      'gitconfig',
    ),
    LANG: 'en_US.UTF-8',
    NODE_OPTIONS: `--max-old-space-size=${CHILD_HEAP_MB}`,
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

beforeAll(async () => {
  const { homeDatabase } = await import('#store/postgres.ts')
  const admin = new pg.Client({ database: 'postgres' })
  await admin.connect()
  await admin.query(`create database ${pg.escapeIdentifier(homeDatabase())} template ${pg.escapeIdentifier(inject('template'))} strategy file_copy`)
  await admin.end()
})

const removeRoot = () => rmSync(
  root,
  {
    recursive: true,
    force: true,
  },
)

afterAll(async () => {
  const { closeNativeHomes } = await import('#app/native-home.ts')
  await closeNativeHomes()
  const { closePostgres } = await import('#store/postgres.ts')
  await closePostgres()
  keepFiles({ from: root })
  removeRoot()
  // The server's exit handler flushes its log into the home after this hook, so a listener added later removes it again.
  process.once(
    'exit',
    removeRoot,
  )
})
