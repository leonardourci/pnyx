import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { once } from 'node:events'
import { hydraDir } from '#app/home-migration.ts'
import { processStart } from '#app/server-state.ts'
import { stopOldHost, trackChildren } from './children.ts'

const idle = () => spawn(
  process.execPath,
  [
    '-e',
    'setInterval(() => {}, 1000)',
  ],
  { stdio: 'ignore' },
)

const ended = async ({ child }: { child: ChildProcess }) => {
  if (child.exitCode === null && child.signalCode === null) {
    await once(
      child,
      'exit',
    )
  }

  return child.signalCode
}

test(
  'a start stops the agent processes an earlier server left running, and leaves one that is gone or reused alone',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-children-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const left = idle()
    const finished = idle()
    const unrelated = idle()
    t.after(() => {
      for (const child of [
        left,
        finished,
        unrelated,
      ]) {
        child.kill('SIGKILL')
      }

      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    mkdirSync(
      hydraDir({ hydraId: 'default' }),
      { recursive: true },
    )

    const crashed = trackChildren({ hydraId: 'default' })
    crashed.spawned({ child: left })
    crashed.spawned({ child: finished })
    finished.kill('SIGTERM')
    await ended({ child: finished })

    const path = join(
      hydraDir({ hydraId: 'default' }),
      'children.json',
    )
    assert.deepEqual(
      JSON.parse(readFileSync(
        path,
        'utf8',
      )).map(({ pid }: { pid: number }) => pid),
      [left.pid],
    )

    // A recorded pid now held by another process has a different start time.
    writeFileSync(
      path,
      JSON.stringify([
        {
          pid: left.pid,
          start: processStart({ pid: left.pid! }),
        },
        {
          pid: unrelated.pid,
          start: 'Thu Jan  1 00:00:00 1970',
        },
      ]),
    )

    trackChildren({ hydraId: 'default' }).sweep()

    assert.equal(
      await ended({ child: left }),
      'SIGKILL',
    )
    assert.equal(
      unrelated.exitCode ?? unrelated.signalCode,
      null,
    )
  },
)

test(
  'a start stops a verified old agent host and ignores a stale owner record',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-old-host-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const host = idle()
    t.after(() => {
      host.kill('SIGKILL')
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    mkdirSync(join(
      home,
      'native',
    ))
    const owner = join(
      home,
      'native/owner.json',
    )
    writeFileSync(
      owner,
      JSON.stringify({
        pid: host.pid,
        start: 'Thu Jan  1 00:00:00 1970',
      }),
    )
    await stopOldHost()
    assert.equal(
      host.exitCode ?? host.signalCode,
      null,
    )

    writeFileSync(
      owner,
      JSON.stringify({
        pid: host.pid,
        start: processStart({
          pid: host.pid!,
          localTime: true,
        }),
      }),
    )
    await stopOldHost()
    assert.equal(
      await ended({ child: host }),
      'SIGTERM',
    )
  },
)
