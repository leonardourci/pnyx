import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { hydraDir } from '#app/home-migration.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'
import { HELPER_INSTRUCTIONS } from '#routine-helper/runner.ts'
import { hydraMessages } from '#hydra/chat-messages.ts'
import { until, RECOVERY_TEST_PAUSE_MS } from '#test-harness/harness.ts'
import { withWriter } from '#app/writer.ts'
import { decideReply } from '#workers/reply-rules.ts'
import type { HydraEvent } from '#app/model.ts'
import { asRecord } from '#app/command-validation.ts'

function failEventWrites({
  t,
  reject,
}: {
  t: TestContext
  reject({ event }: { event: Record<string, unknown> }): boolean
}) {
  const replacement = new Proxy(
    fs.writeSync,
    {
    // eslint-disable-next-line pnyx/object-params -- JavaScript owns Proxy's apply trap signature.
      apply(
        target,
        receiver,
        args: unknown[],
      ) {
        const payload = args[1]
        let serialized = ''

        if (Buffer.isBuffer(payload)) {
          serialized = payload.toString('utf8')
        } else if (typeof payload === 'string') {
          serialized = payload
        }

        let event: unknown

        try {
          event = JSON.parse(serialized)
        } catch {
          return Reflect.apply(
            target,
            receiver,
            args,
          )
        }

        const record = asRecord({ value: event })

        if (record && reject({ event: record })) {
          throw Object.assign(
            new Error('Synthetic durable event write failure'),
            { code: 'EIO' },
          )
        }

        return Reflect.apply(
          target,
          receiver,
          args,
        )
      },
    },
  )
  t.mock.method(
    fs,
    'writeSync',
    replacement,
  )
  syncBuiltinESMExports()
}

function recordFailed({
  s,
  task,
  message,
  text,
}: {
  s: Scenario
  task: string
  message: string
  text: string
}) {
  withWriter({
    hydraId: s.hydraId,
    fn: ({ writer }) => {
      const queued = decideReply({
        state: writer.state,
        ref: task,
        data: {
          reply: message,
          route: 'pnyx',
          state: 'queued',
          text,
        },
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in queued)
      writer.append({ event: queued.event })
      const failed = decideReply({
        state: writer.state,
        ref: task,
        data: {
          reply: message,
          route: 'pnyx',
          state: 'failed',
        },
        meta: {
          actor: 'pnyx',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in failed)
      writer.append({ event: failed.event })
    },
  })
}

test(
  'safe message recovery logs delivery, pauses before its second failed attempt and keeps the budget after restart',
  async t => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'worker',
        '--title',
        'Worker',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'worker',
        '--harness',
        'codex',
        '--prompt',
        'Become idle',
      ],
    })
    await until({
      what: 'worker idle',
      check: () => s.task({ key: 'worker' }).sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ helper: 'auto' }),
      ],
    })
    const task = s.task({ key: 'worker' })
    t.after(async () => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ helper: 'off' }),
        ],
      })
    })
    pnyx.claude.plan({
      match: ({ text }) => text.endsWith(HELPER_INSTRUCTIONS),
      reply: JSON.stringify({
        outcomes: [
          {
            task: task.id,
            audience: 'routine',
            summary: 'Checked.',
          },
        ],
      }),
    })
    pnyx.claude.plan({
      match: ({ text }) => text.endsWith(HELPER_INSTRUCTIONS),
      reply: JSON.stringify({
        outcomes: [
          {
            task: task.id,
            audience: 'routine',
            summary: 'Checked.',
          },
        ],
      }),
    })
    let persistenceFailures = 0
    t.mock.method(
      console,
      'error',
      () => {},
    )
    failEventWrites({
      t,
      reject: ({ event }) => {
        if (event.type === 'diagnostic.retry' && event.cardId === task.id) {
          persistenceFailures++

          return true
        }

        return false
      },
    })
    recordFailed({
      s,
      task: task.id,
      message: 'blocked-message',
      text: 'SYNTHETIC_BLOCKED_PAYLOAD',
    })
    await until({
      what: 'recovery log failure',
      check: () => persistenceFailures > 0,
    })
    const stopped = await s.owner({
      args: [
        'debug',
        'health',
      ],
    })
    await s.owner({
      args: [
        'debug',
        'health',
      ],
    })
    await s.owner({
      args: [
        'debug',
        'health',
      ],
    })
    await s.owner({
      args: [
        'debug',
        'health',
      ],
    })
    assert.equal(
      persistenceFailures,
      1,
      'repeated scheduler kicks must not relaunch an unrecorded attempt',
    )
    assert.match(
      stopped,
      /recovery event persistence failed; automation stopped/,
    )
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes('SYNTHETIC_BLOCKED_PAYLOAD')).length,
      0,
    )
    t.mock.restoreAll()
    syncBuiltinESMExports()
    recordFailed({
      s,
      task: task.id,
      message: 'recover-message',
      text: 'SYNTHETIC_RECOVERY_PAYLOAD',
    })
    await until({
      what: 'recorded recovery delivery',
      check: () => s.events().some(event => event.type === 'diagnostic.retry' && event.data.message === 'recover-message' && event.data.status === 'delivered'),
    })
    await until({
      what: 'worker to finish recovery',
      check: () => s.task({ key: 'worker' }).sessionActivity === 'finished',
    })
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes('SYNTHETIC_RECOVERY_PAYLOAD')).length,
      1,
    )
    assert.deepEqual(
      s.events().filter(event => event.type === 'diagnostic.retry')
        .map(event => event.data.status),
      [
        'reserved',
        'delivered',
      ],
    )
    assert.equal(
      s.task({ key: 'worker' }).replies?.find(reply => reply.id === 'recover-message')?.state,
      'delivered',
    )
    recordFailed({
      s,
      task: task.id,
      message: 'exhaust-message',
      text: 'SYNTHETIC_UNSENT_PAYLOAD',
    })
    t.mock.method(
      console,
      'error',
      () => {},
    )
    failEventWrites({
      t,
      reject: ({ event }) => {
        const data = asRecord({ value: event.data })
        const message = asRecord({ value: data?.message })

        return event.type === 'task.steering.queued' && event.cardId === task.id
          && message?.id === 'exhaust-message'
      },
    })
    await until({
      what: 'two recorded recovery failures',
      check: () => s.events().filter(event => event.type === 'diagnostic.retry' && event.data.message === 'exhaust-message' && event.data.status === 'failed').length === 2,
    })
    const attempts = s.events().filter((event): event is Extract<HydraEvent, { type: 'diagnostic.retry' }> => event.type === 'diagnostic.retry' && event.data.message === 'exhaust-message')
    assert.deepEqual(
      attempts.map(event => event.data.status),
      [
        'reserved',
        'failed',
        'reserved',
        'failed',
      ],
    )
    const retryPause = Date.parse(attempts[2]!.at) - Date.parse(attempts[1]!.at)
    assert.ok(
      retryPause >= RECOVERY_TEST_PAUSE_MS,
      `Retry pause was ${retryPause}ms; expected at least ${RECOVERY_TEST_PAUSE_MS}ms`,
    )
    const notices = () => s.events().filter(event => event.type === 'hydra.message' && event.messageId === 'exhaust-message')
    assert.equal(
      notices().length,
      1,
    )
    assert.ok(hydraMessages({
      messages: s.state().hydraMessages ?? [],
      transcript: [],
    })
      .some(entry => entry.role === 'Pnyx' && entry.text.includes('Automatic message recovery stopped')))
    assert.equal(
      s.received({ cwd: folder }).filter(text => text.includes('SYNTHETIC_UNSENT_PAYLOAD')).length,
      0,
    )
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await pnyx.restart()
    await s.owner({
      args: [
        'debug',
        'health',
      ],
    })
    assert.equal(
      s.events().filter((event): event is Extract<HydraEvent, { type: 'diagnostic.retry' }> => event.type === 'diagnostic.retry' && event.data.message === 'exhaust-message').length,
      4,
    )
    assert.equal(
      notices().length,
      1,
    )
    const received = s.received({ cwd: folder }).length
    recordFailed({
      s,
      task: task.id,
      message: 'uncertain-message',
      text: 'SYNTHETIC_UNCONFIRMED_PAYLOAD',
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const sessionId = writer.state.cards[task.id]?.sessionIds?.[0]
        assert.ok(sessionId)
        const at = new Date().toISOString()
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'synthetic-reservation',
            at,
            actor: 'pnyx',
            cardId: task.id,
            type: 'diagnostic.retry',
            data: {
              message: 'uncertain-message',
              number: 1,
              status: 'reserved',
              sessionId,
              at,
            },
          },
        })
        const queued = decideReply({
          state: writer.state,
          ref: task.id,
          data: {
            reply: 'uncertain-message',
            route: 'pnyx',
            state: 'queued',
          },
          meta: {
            actor: 'pnyx',
            at,
          },
        })
        assert.ok('event' in queued)
        writer.append({ event: queued.event })
      },
    })
    await until({
      what: 'uncertain attempt notice',
      check: () => s.events().some(event => event.type === 'hydra.message' && event.messageId === 'uncertain-message'),
    })
    assert.match(
      await s.owner({
        args: [
          'debug',
          'health',
        ],
      }),
      /uncertain-message/,
    )
    assert.equal(
      s.received({ cwd: folder }).length,
      received,
    )
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const confirmed = decideReply({
          state: writer.state,
          ref: task.id,
          data: {
            reply: 'uncertain-message',
            route: 'pnyx',
            state: 'delivered',
          },
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in confirmed)
        writer.append({ event: confirmed.event })
      },
    })
    await until({
      what: 'recorded confirmation without a resend',
      check: () => s.events().some(event => event.type === 'diagnostic.retry' && event.data.message === 'uncertain-message' && event.data.status === 'delivered'),
    })
    assert.equal(
      s.received({ cwd: folder }).length,
      received,
    )
  },
)

test(
  'debug queries page correlated events without message bodies or writes and report runtime health',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Synthetic work',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'work',
        'blocked',
        '--note',
        'PRIVATE_SYNTHETIC_BODY',
      ],
    })
    const before = readFileSync(
      join(
        hydraDir({ hydraId: s.hydraId }),
        'events.jsonl',
      ),
      'utf8',
    )
    const output = await s.owner({
      args: [
        'debug',
        'timeline',
        '--task',
        'work',
        '--limit',
        '1',
      ],
    })
    assert.match(
      output,
      /task.declared|card.moved/,
    )
    assert.ok(!output.includes('PRIVATE_SYNTHETIC_BODY'))
    assert.match(
      output,
      /cursor:/,
    )
    const health = await s.owner({
      args: [
        'debug',
        'health',
      ],
    })
    assert.match(
      health,
      /scheduler/,
    )
    assert.match(
      health,
      /lastSuccessAt/,
    )
    assert.equal(
      readFileSync(
        join(
          hydraDir({ hydraId: s.hydraId }),
          'events.jsonl',
        ),
        'utf8',
      ),
      before,
    )
    const invalid = await s.ownerRefusal({
      args: [
        'debug',
        'timeline',
        '--limit',
        '0',
      ],
    })
    assert.equal(
      invalid.code,
      'VALIDATION_ERROR',
    )
  },
)
