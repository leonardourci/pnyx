import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test(
  'the test launcher isolates its environment and fails on listener leaks',
  () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verification/test.ts',
        'scripts/verification/fixtures/launcher-probe.ts',
      ],
      {
        env: {
          ...process.env,
          PATH: '/unavailable/outer-bin',
          PNYX_ACTOR: 'worker:live',
          PNYX_HYDRA: 'live',
          PNYX_TASK: 'live',
          PORT: '4747',
          NODE_OPTIONS: '--trace-warnings',
          CHROME_DEVTOOLS_AXI_PORT: '4747',
          CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '1',
          GIT_CONFIG_GLOBAL: '/unavailable/outer-gitconfig',
        },
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`,
    )
    const leaking = spawnSync(
      process.execPath,
      [
        'scripts/verification/test.ts',
        'scripts/verification/fixtures/listener-leak.ts',
      ],
      { encoding: 'utf8' },
    )
    assert.match(
      `${leaking.stdout}\n${leaking.stderr}`,
      /MaxListenersExceededWarning/,
    )
    assert.notEqual(
      leaking.status,
      0,
      `${leaking.stdout}\n${leaking.stderr}`,
    )
  },
)
