import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { stagedBuild } from './staged.ts'
import { killMidway } from '#test-harness/kill-midway.ts'

const CLI = 'cli/pnyx-axi.js'
const WRITTEN_MS = 10_000

const temp = mkdtempSync(join(
  tmpdir(),
  'pnyx-build-',
))
after(() => rmSync(
  temp,
  {
    recursive: true,
    force: true,
  },
))

const writeCli = ({
  out,
  text,
}: {
  out: string
  text: string
}) => {
  mkdirSync(
    join(
      out,
      'cli',
    ),
    { recursive: true },
  )
  writeFileSync(
    join(
      out,
      CLI,
    ),
    text,
  )
}

const building = ({ version }: { version: string }) => ({ out }: { out: string }) => writeCli({
  out,
  text: `console.log('${version}')\n`,
})

let root: string

// Runs the built CLI; a half-written file fails to parse.
const cli = () => execFileSync(
  process.execPath,
  [
    join(
      root,
      'dist',
      CLI,
    ),
  ],
  { encoding: 'utf8' },
).trim()

beforeEach(() => {
  root = mkdtempSync(join(
    temp,
    'case-',
  ))
  stagedBuild({
    root,
    build: building({ version: 'one' }),
  })
})

test(
  'a passing build replaces dist and leaves no other folder',
  () => {
    stagedBuild({
      root,
      build: building({ version: 'two' }),
    })

    assert.equal(
      cli(),
      'two',
    )
    assert.deepEqual(
      readdirSync(root),
      ['dist'],
    )
  },
)

test(
  'a failed build keeps the old dist',
  () => {
    assert.throws(
      () => stagedBuild({
        root,
        build: ({ out }) => {
          writeCli({
            out,
            text: 'console.lo',
          })

          throw new Error('error TS2322')
        },
      }),
      /TS2322/,
    )

    assert.equal(
      cli(),
      'one',
    )
    assert.deepEqual(
      readdirSync(root),
      ['dist'],
    )
  },
)

test(
  'a build killed halfway keeps the old dist, and the next build still passes',
  async () => {
    const written = join(
      root,
      'written',
    )
    // Writes half a CLI, then hangs as a compiler cut mid-write would have.
    const hanging = `
      import { execFileSync } from 'node:child_process'
      import { mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { stagedBuild } from ${JSON.stringify(new URL(
        './staged.ts',
        import.meta.url,
      ).href)}

      stagedBuild({
        root: ${JSON.stringify(root)},
        build: ({ out }) => {
          mkdirSync(join(out, 'cli'), { recursive: true })
          writeFileSync(join(out, ${JSON.stringify(CLI)}), 'console.lo')
          writeFileSync(${JSON.stringify(written)}, '')
          execFileSync('sleep', ['30'])
        },
      })
    `
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        hanging,
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    await killMidway({
      child,
      reached: written,
      timeoutMs: WRITTEN_MS,
    })
    rmSync(written)

    assert.equal(
      cli(),
      'one',
    )

    stagedBuild({
      root,
      build: building({ version: 'two' }),
    })

    assert.equal(
      cli(),
      'two',
    )
    assert.deepEqual(
      readdirSync(root),
      ['dist'],
    )
  },
)

test(
  'a build finds the last working dist a swap cut halfway left aside',
  () => {
    renameSync(
      join(
        root,
        'dist',
      ),
      join(
        root,
        'dist.old',
      ),
    )

    assert.throws(() => stagedBuild({
      root,
      build: () => {
        throw new Error('error TS2322')
      },
    }))

    assert.equal(
      cli(),
      'one',
    )
  },
)
