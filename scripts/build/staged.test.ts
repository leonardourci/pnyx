import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stagedBuild } from './staged.ts'

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

// What the built CLI prints, which only a whole file can.
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
    const half = join(
      root,
      'dist.next',
      CLI,
    )
    // Writes half a CLI, then hangs as a compiler cut mid-write would have.
    const hanging = `
      const { mkdirSync, writeFileSync } = require('node:fs')
      const { execFileSync } = require('node:child_process')
      const { dirname } = require('node:path')
      import(${JSON.stringify(new URL(
        './staged.ts',
        import.meta.url,
      ).href)}).then(({ stagedBuild }) => stagedBuild({
        root: ${JSON.stringify(root)},
        build: () => {
          mkdirSync(dirname(${JSON.stringify(half)}), { recursive: true })
          writeFileSync(${JSON.stringify(half)}, 'console.lo')
          execFileSync('sleep', ['30'])
        },
      }))
    `
    const child = spawn(
      process.execPath,
      [
        '-e',
        hanging,
      ],
      {
        detached: true,
        stdio: 'ignore',
      },
    )
    const closed = new Promise(resolve => child.once(
      'close',
      resolve,
    ))
    const deadline = Date.now() + WRITTEN_MS

    while (!existsSync(half) && Date.now() < deadline) {
      await delay(20)
    }

    assert.ok(existsSync(half))
    // The whole group, as a stopped session takes its build down with it.
    process.kill(
      -child.pid!,
      'SIGKILL',
    )
    await closed

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
