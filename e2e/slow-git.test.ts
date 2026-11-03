import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

// The fake git waits this long on every call, and project show makes five calls in a row.
const SLOW_GIT_MS = 500
const TICK_MS = 25
// Below one git call: a synchronous call stalls the loop at least SLOW_GIT_MS, while a busy machine's ordinary work stays well under it.
const MAX_STALL_MS = SLOW_GIT_MS * 0.8

test(
  'a project show waiting on a slow git leaves the server answering other clients',
  async t => {
    const s = await pnyx.scenario()
    await s.project({ name: 'slow' })
    const log = join(
      realpathSync(mkdtempSync('/tmp/pnyx-slow-git-')),
      'calls',
    )
    const path = process.env.PATH
    process.env.PATH = `${join(
      import.meta.dirname,
      'fixtures',
      'slow-git',
    )}:${path}`
    process.env.SLOW_GIT_LOG = log
    process.env.SLOW_GIT_SECONDS = String(SLOW_GIT_MS / 1000)
    t.after(() => {
      process.env.PATH = path
      delete process.env.SLOW_GIT_LOG
      delete process.env.SLOW_GIT_SECONDS
    })

    let last = Date.now()
    let stall = 0
    const ticker = setInterval(
      () => {
        const now = Date.now()
        stall = Math.max(
          stall,
          now - last - TICK_MS,
        )
        last = now
      },
      TICK_MS,
    )
    t.after(() => clearInterval(ticker))

    const started = Date.now()
    let shown = false
    const showing = (async () => {
      const output = await s.owner({
        args: [
          'project',
          'show',
          'slow',
        ],
      })
      shown = true

      return output
    })()

    await until({
      what: 'the server to call the slow git',
      check: () => existsSync(log),
    })
    const asked = Date.now()
    const health = await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/health`)
    const answered = Date.now() - asked
    assert.equal(
      health.status,
      200,
    )
    assert.equal(
      shown,
      false,
      'project show finished before the other client asked',
    )
    assert.ok(
      answered < MAX_STALL_MS,
      `health took ${answered} ms while git was slow`,
    )

    const output = await showing
    assert.ok(
      Date.now() - started >= SLOW_GIT_MS,
      'project show did not wait on the slow git',
    )
    assert.match(
      output,
      /ref: refs\/remotes\/origin\/main/,
    )
    assert.ok(
      stall < MAX_STALL_MS,
      `the event loop stalled ${stall} ms`,
    )
  },
)
