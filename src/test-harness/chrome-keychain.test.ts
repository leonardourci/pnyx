import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const LAUNCHER_FIXTURE = fileURLToPath(new URL(
  './fixtures/chrome-under-launcher.ts',
  import.meta.url,
))
const HARNESS_FIXTURE = fileURLToPath(new URL(
  './fixtures/chrome-under-harness.ts',
  import.meta.url,
))

function node({ args }: { args: string[] }) {
  const env = { ...process.env }
  // A nested run reports to its own runner, not to this one.
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(
    process.execPath,
    args,
    {
      env,
      encoding: 'utf8',
    },
  )

  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  }
}

test(
  'every test process that moves HOME starts Chrome with the Keychain mocked',
  () => {
    const launched = node({
      args: [
        'scripts/verification/test.ts',
        LAUNCHER_FIXTURE,
      ],
    })
    assert.equal(
      launched.status,
      0,
      launched.output,
    )

    const harnessed = node({
      args: [
        '--conditions=source',
        '--test',
        HARNESS_FIXTURE,
      ],
    })
    assert.equal(
      harnessed.status,
      0,
      harnessed.output,
    )

    const unguarded = node({
      args: [
        '--conditions=source',
        '--test',
        LAUNCHER_FIXTURE,
      ],
    })
    assert.notEqual(
      unguarded.status,
      0,
      unguarded.output,
    )
    assert.match(
      unguarded.output,
      /--use-mock-keychain/,
    )
  },
)
