import { until } from '#test-harness/harness.ts'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

    assert.equal(
      await trackChildren({ hydraId: 'default' }).sweep(),
      true,
    )

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

test(
  'restart preserves tools after their leader exits and permanent close reaps their group',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-children-tree-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const gate = join(
      home,
      'gate',
    )
    const marker = join(
      home,
      'written-after-recovery',
    )
    // The tool waits for the gate, then writes; the agent started it and keeps running.
    const ready = join(
      home,
      'ready',
    )
    const tool = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'old tool') } }, 20)`
    const agent = spawn(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
      ],
      {
        stdio: 'ignore',
        // As the providers start their agents.
        detached: true,
      },
    )
    t.after(() => {
      try {
        process.kill(
          -agent.pid!,
          'SIGKILL',
        )
      } catch {
        // Already gone, as the test expects.
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
    const tracker = trackChildren({ hydraId: 'default' })
    tracker.spawned({ child: agent })
    tracker.associate({
      pid: agent.pid!,
      task: 'worker',
    })
    await until({
      what: 'tool ready',
      check: () => existsSync(ready),
    })

    assert.equal(
      await trackChildren({ hydraId: 'default' }).sweep(),
      true,
    )
    await ended({ child: agent })
    writeFileSync(
      gate,
      '',
    )
    await until({
      what: 'background tool writes after restart',
      check: () => existsSync(marker),
    })

    assert.equal(
      existsSync(marker),
      true,
      'background work survives restart',
    )
    const recovered = trackChildren({ hydraId: 'default' })
    await recovered.sweep()
    await recovered.stop({ task: 'worker' })
    assert.throws(
      () => process.kill(
        -agent.pid!,
        0,
      ),
      { code: 'ESRCH' },
    )
    assert.deepEqual(
      JSON.parse(readFileSync(
        join(
          hydraDir({ hydraId: 'default' }),
          'children.json',
        ),
        'utf8',
      )),
      [],
    )
  },
)
