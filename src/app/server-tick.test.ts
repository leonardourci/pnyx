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
import { openDecisions } from '#tasks/decisions.ts'

test(
  'a recovery failure does not prevent reminders, deferred questions or scheduler health advancing',
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
    await commands.settings([
      'set',
      '--json',
      '{"reviewMinutes":0}',
      '--hydra',
      'lab',
    ])
    const asked = await commands.task([
      'ask',
      task,
      '--question',
      'Which response format?',
      '--to',
      'owner',
      '--actor',
      'hydra',
      '--reason',
      'The owner chooses',
      '--hydra',
      'lab',
    ])
    const question = String(asked.ask)
    const until = '2099-11-10T12:00:00.000Z'
    await commands.task([
      'defer-question',
      task,
      question,
      '--until',
      until,
      '--hydra',
      'lab',
    ])
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
    let time = Date.now()
    let scheduled: {
      at: number
      fire(): void
    } | undefined
    const tick = createServerTick({
      hydraId: 'lab',
      dir: hydraDir({ hydraId: 'lab' }),
      state,
      closed: () => closed,
      pump: () => {},
      followDelay: 60_000,
      reminderScheduler: {
        now: () => time,
        schedule: ({
          at,
          fire,
        }) => {
          scheduled = {
            at,
            fire,
          }

          return () => {}
        },
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
    assert.equal(
      scheduled?.at,
      Date.parse(until),
    )
    assert.equal(
      openDecisions({ state: state() }).some(item => item.id === question),
      false,
    )
    time = Date.parse(until) - 1
    tick.kick()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(
      openDecisions({ state: state() }).some(item => item.id === question),
      false,
    )
    time = Date.parse(until)
    assert.ok(scheduled)
    scheduled.fire()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(
      openDecisions({ state: state() }).some(item => item.id === question),
      true,
    )
    assert.equal(
      state().cards[task]?.asks?.[0]?.answered,
      undefined,
    )
    assert.equal(
      state().hydraMessages?.some(message => message.reminderQuestions?.length),
      false,
    )
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
