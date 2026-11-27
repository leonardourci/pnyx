import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll } from 'vitest'
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
  'othrys',
  'quota-axi',
  'launchctl',
  'systemctl',
  'brew',
]
const CHILD_HEAP_MB = 1024
const KEEP = /^(VITEST|__VITEST|CI$|TERM$|FORCE_COLOR$|NO_COLOR$|OTHRYS_KEEP_TEST_FILES$)/

// Short paths leave room for the Unix socket names Othrys makes inside its home.
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

const realHomeBrowserCache = process.platform === 'darwin'
  ? join(
    homedir(),
    'Library/Caches',
  )
  : process.env.XDG_CACHE_HOME || join(
    homedir(),
    '.cache',
  )
const playwrightBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH || join(
  realHomeBrowserCache,
  'ms-playwright',
)

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
    OTHRYS_HOME: join(
      root,
      'othrys',
    ),
    CLAUDE_CONFIG_DIR: join(
      root,
      'claude',
    ),
    CODEX_HOME: join(
      root,
      'codex',
    ),
    OTHRYS_GH_AXI: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(
      root,
      'gitconfig',
    ),
    LANG: 'en_US.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsers,
    NODE_OPTIONS: `--max-old-space-size=${CHILD_HEAP_MB}`,
  },
)

for (const key of [
  'HOME',
  'TMPDIR',
  'OTHRYS_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
]) {
  mkdirSync(
    process.env[key]!,
    { recursive: true },
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
  const { closeNativeHomes } = await import('#app/native-home.ts')
  await closeNativeHomes()
  keepFiles({ from: root })
  removeRoot()
  // The server's exit handler flushes its log into the home after this hook, so a listener added later removes it again.
  process.once(
    'exit',
    removeRoot,
  )
})
