import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

function run({ args = [] }: { args?: string[] } = {}): string {
  const env = {
    ...process.env,
    PNYX_HOME: mkdtempSync(join(
      tmpdir(),
      'pnyx-test-',
    )),
  }

  return execFileSync(
    process.execPath,
    [
      BIN,
      ...args,
    ],
    {
      env,
      encoding: 'utf8',
    },
  )
}

test(
  'no arguments prints an empty Hydra summary',
  () => {
    const out = run({ })
    assert.match(
      out,
      /^hydraId: default$/m,
    )
    assert.match(
      out,
      /^ {2}needs_you: 0$/m,
    )
    assert.match(
      out,
      /^cards: "none: no cards yet"$/m,
    )
    assert.match(
      out,
      /pnyx-axi task create --title/,
    )
  },
)

test(
  '--help prints concise help',
  () => {
    const out = run({ args: ['--help'] })
    assert.match(
      out,
      /^usage: pnyx-axi/,
    )
    assert.ok(out.split('\n').length < 40)
  },
)

test(
  'task permission takes --actor hydra and names what it parsed when the choice is missing',
  () => {
    const failure = ({ args }: { args: string[] }) => {
      try {
        run({ args })
      } catch (error) {
        return (error as { stdout: string }).stdout
      }

      return assert.fail('expected a failure')
    }

    assert.match(
      failure({
        args: [
          'task',
          'permission',
          'task-1 request-1',
          'allow',
          '--actor',
          'hydra',
          '--reason',
          'Scoped',
        ],
      }),
      /allow\|deny \(got 'task-1 request-1' 'allow'\)/,
    )
    assert.match(
      failure({
        args: [
          'task',
          'permission',
          'task-1',
          'request-1',
          'allow',
          '--actor',
          'hydra',
          '--reason',
          'Scoped',
        ],
      }),
      /^code: NOT_RUNNING$/m,
    )
  },
)

test(
  'update fails with a structured error while unpublished',
  () => {
    assert.throws(
      () => run({ args: ['update'] }),
      (error: {
        status: number
        stdout: string
      }) => {
        assert.equal(
          error.status,
          2,
        )
        assert.match(
          error.stdout,
          /^code: VALIDATION_ERROR$/m,
        )

        return true
      },
    )
  },
)

test(
  'hydra stop and usage say so when no server runs the Hydra',
  () => {
    assert.match(
      run({
        args: [
          'hydra',
          'stop',
        ],
      }),
      /^stopped: "none: no Pnyx server runs this Hydra"$/m,
    )
    assert.match(
      run({
        args: [
          'hydra',
          'usage',
        ],
      }),
      /^usage: "none: no Pnyx server runs this Hydra"$/m,
    )
  },
)
