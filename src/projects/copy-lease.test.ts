import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '#app/server-daemon.ts'
import type { RunningServer } from '#app/server-transport.ts'
import { taskLease } from '#routine-helper/leases.ts'
import { COPY_LEASE_PREFIX, copySettling } from './copy-lease.ts'

test(
  'a server start drops a copy settlement lease an earlier server left behind',
  async t => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-copy-lease-',
    ))
    process.env.PNYX_HOME = home
    // The earlier server's pid, now held by an unrelated live process.
    const unrelated = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      { stdio: 'ignore' },
    )
    const resources: { server?: RunningServer } = {}
    t.after(async () => {
      await resources.server?.close()
      unrelated.kill('SIGKILL')
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    resources.server = await startServer({})
    await resources.server.close()
    resources.server = undefined
    taskLease({
      hydraId: 'default',
      task: 'task-left',
      actor: `${COPY_LEASE_PREFIX}crashed`,
      pid: unrelated.pid,
    })
    // A pid now held by another user's process, which this one may not signal.
    taskLease({
      hydraId: 'default',
      task: 'task-other-user',
      actor: `${COPY_LEASE_PREFIX}crashed`,
      pid: 1,
    })
    assert.equal(
      copySettling({
        hydraId: 'default',
        task: 'task-left',
      }),
      true,
    )

    resources.server = await startServer({})
    assert.equal(
      copySettling({
        hydraId: 'default',
        task: 'task-left',
      }),
      false,
    )
    assert.equal(
      copySettling({
        hydraId: 'default',
        task: 'task-other-user',
      }),
      false,
    )
  },
)
