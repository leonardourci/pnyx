import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function createTestEnvironment() {
  // Short paths also leave room for Unix socket names inside a test's own folders.
  const root = realpathSync(mkdtempSync('/tmp/pt-'))
  const bin = join(
    root,
    'bin',
  )
  mkdirSync(bin)

  for (const command of [
    'claude',
    'codex',
    'gh',
    'gh-axi',
    'paseo',
    'firstmate',
    'herdr',
    'tmux',
    'pnyx-axi',
  ]) {
    writeFileSync(
      join(
        bin,
        command,
      ),
      `#!/bin/sh
echo "test attempted an unconfigured ${command}" >&2
exit 79
`,
      { mode: 0o755 },
    )
  }

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
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
    PNYX_PASEO_URL: 'ws://127.0.0.1:1/ws',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(
      root,
      'gitconfig',
    ),
    LANG: 'en_US.UTF-8',
  }

  for (const key of [
    'HOME',
    'TMPDIR',
    'PNYX_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
  ]) {
    mkdirSync(
      env[key]!,
      { recursive: true },
    )
  }

  return {
    env,
    close: () => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ),
  }
}
