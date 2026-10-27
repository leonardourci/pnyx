import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test(
  'a launched file owns its environment and cannot reach live tools',
  () => {
    for (const key of [
      'PNYX_ACTOR',
      'PNYX_HYDRA',
      'PNYX_TASK',
      'PORT',
      'PNYX_SEMANTIC',
      'PNYX_SEMANTIC_STUB_FAIL',
      'NODE_OPTIONS',
      'CHROME_DEVTOOLS_AXI_PORT',
      'CHROME_DEVTOOLS_AXI_AUTO_CONNECT',
    ]) {
      assert.equal(
        process.env[key],
        undefined,
        key,
      )
    }

    assert.equal(
      homedir(),
      process.env.HOME,
    )
    assert.equal(
      tmpdir(),
      process.env.TMPDIR,
    )

    const homes = [
      'HOME',
      'PNYX_HOME',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'TMPDIR',
    ].map(key => {
      const path = process.env[key]!
      assert.ok(
        existsSync(path),
        key,
      )
      assert.match(
        realpathSync(path),
        /\/pt-[^/]+\//,
        key,
      )

      return path
    })
    assert.equal(
      new Set(homes).size,
      homes.length,
    )
    assert.equal(
      process.env.PNYX_GH_AXI,
      'false',
    )
    assert.equal(
      process.env.PNYX_PASEO_URL,
      'ws://127.0.0.1:1/ws',
    )
    assert.equal(
      process.env.GIT_CONFIG_GLOBAL,
      join(
        process.env.HOME!,
        '..',
        'gitconfig',
      ),
    )
    assert.throws(
      () => execFileSync(
        'claude',
        ['--help'],
        { stdio: 'pipe' },
      ),
      (error: { status?: number }) => error.status === 79,
    )
  },
)
