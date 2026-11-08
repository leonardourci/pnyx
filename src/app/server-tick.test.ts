import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from './cli.ts'
import { hydraDir } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { withWriter } from './writer.ts'
import { createServerTick } from './server-tick.ts'

test(
  'a recovery failure does not prevent review, due reminders or scheduler health advancing',
  async t => {
    const previous = process.env.PNYX_HOME
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-tick-',
    ))
    process.env.PNYX_HOME = root
    let closed = false
    t.after(() => {
      closed = true

      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await commands.hydra([
      'create',
      'lab',
    ])
    await commands.task([
      'create',
      '--key',
      'work',
      '--title',
      'Work',
      '--hydra',
      'lab',
    ])
    const state = () => loadHydra({ hydraId: 'lab' }).state
    const task = state().keys.work!
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'due-reminder',
          at: new Date().toISOString(),
          actor: 'cli',
          cardId: task,
          type: 'task.reminder',
          data: {
            before: null,
            after: new Date(Date.now() - 1000).toISOString(),
          },
        },
      }),
    })
    const output = t.mock.method(
      console,
      'error',
      () => {},
    )
    let reviewed = 0
    const tick = createServerTick({
      hydraId: 'lab',
      dir: hydraDir({ hydraId: 'lab' }),
      state,
      closed: () => closed,
      pump: () => {},
      followDelay: 60_000,
      reminderScheduler: {
        now: Date.now,
        schedule: () => () => {},
      },
      runWorker: async () => {
        throw new Error('Unexpected worker')
      },
      triedResends: new Map(),
      resendReply: async () => {
        throw new Error('Unexpected resend')
      },
      agents: () => ({ unconfirmed: () => false }),
      sources: () => ({
        reconcile: () => {},
        deadline: () => undefined,
        close: async () => {},
      }),
      review: () => ({
        check: async () => {
          reviewed++
        },
        close: () => {},
      }),
      recover: () => {
        throw new Error('Synthetic recovery observation failure')
      },
    })
    tick.kick()
    await new Promise<void>(resolve => setImmediate(resolve))
    closed = true
    clearTimeout(tick.expiryTimer)
    tick.cancelReminder()
    await tick.queueRun
    assert.ok(reviewed > 0)
    assert.ok(state().cards[task]?.reminder?.dueAt)
    assert.ok(tick.health().lastSuccessAt)
    assert.equal(
      tick.health().lastFailureAt,
      undefined,
    )
    assert.ok(output.mock.calls.some(call => JSON.parse(String(call.arguments[0])).operation === 'diagnostic reconcile'))
  },
)
