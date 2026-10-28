import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { hydraDir } from '#app/home-migration.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { startReviewTimer, REVIEW_MS } from '#hydra/review-timer.ts'
import { QUESTION_REMINDER_MS } from '#hydra/review.ts'
import { eventReasons } from '#hydra/wake-reasons.ts'
import { until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

function reviewClock({
  s,
  at = Date.now(),
}: {
  s: Scenario
  at?: number
}) {
  let time = at
  let wakes = 0
  const start = () => startReviewTimer({
    hydraId: s.hydraId,
    now: () => time,
    interval: () => () => {},
    wake: () => wakes++,
  })
  let timer = start()

  return {
    advance: ({ ms = REVIEW_MS }: { ms?: number } = {}) => {
      time += ms
      timer.check()
      const event = s.events().findLast(event => event.type === 'hydra.review')
      assert.ok(event)
      assert.equal(
        event.at,
        new Date(time).toISOString(),
      )
      const reasons = eventReasons({
        state: s.state(),
        event,
      })

      return {
        wakes,
        reasons: reasons.map(reason => reason.kind),
        block: event.data.block,
      }
    },
    restart: () => {
      timer.close()
      timer = start()
    },
    close: () => timer.close(),
  }
}

test(
  'timed reviews keep quiet for ready work, zero flags and memory lag',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ready work',
        '--key',
        'ready',
      ],
    })
    const clock = reviewClock({ s })

    try {
      assert.deepEqual(
        clock.advance().reasons,
        [],
      )
      assert.equal(
        clock.advance().wakes,
        0,
      )
      await s.owner({
        args: [
          'hydra',
          'memory',
          'set',
          '--key',
          'check-cursor',
          '--text',
          '0',
        ],
      })
      const memory = clock.advance()
      assert.match(
        memory.block,
        /memory behind/,
      )
      assert.deepEqual(
        memory.reasons,
        [],
      )
      assert.equal(
        memory.wakes,
        0,
      )
      clock.restart()
      assert.equal(
        clock.advance().wakes,
        0,
      )
      assert.equal(
        s.state().cards[HYDRA_CARD]?.agent,
        undefined,
      )
    } finally {
      clock.close()
    }
  },
)

test(
  'a timed review finds missing workers and unwatched PRs once, including after restart',
  async () => {
    const s = await pnyx.scenario()
    const project = await s.project({
      name: 'review-app',
      flags: [
        '--landing',
        'pr',
        '--merge',
        'owner',
      ],
    })
    const progress = s.column({ role: 'in_progress' })
    const parked = s.column({ role: 'parked' })
    assert.ok(progress)
    assert.ok(parked)

    const move = async ({ column }: { column: string }) => {
      const args = [
        'move',
        'watch',
        column,
      ]
      const preview = await s.owner({ args })
      const token = /^token: (\S+)$/m.exec(preview)?.[1]
      assert.ok(token)
      await s.owner({
        args: [
          ...args,
          '--confirm',
          token,
        ],
      })
      assert.equal(
        s.task({ key: 'watch' }).column,
        column,
      )
    }

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Watch the change',
        '--project',
        project,
        '--key',
        'watch',
        '--column',
        progress,
      ],
    })
    const url = s.pullRequest({
      number: 701,
      checks: 'pending',
      draft: true,
    })
    await s.owner({
      args: [
        'link',
        'watch',
        '--url',
        url,
        '--kind',
        'github_pr',
        '--state',
        'open',
      ],
    })
    const clock = reviewClock({ s })

    try {
      const first = clock.advance()
      assert.match(
        first.block,
        /no live worker/,
      )
      assert.match(
        first.block,
        /unwatched PR/,
      )
      assert.equal(
        first.wakes,
        1,
      )
      assert.deepEqual(
        first.reasons,
        ['timed review'],
      )
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'Hydra to finish the timed review',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished'
        && s.received({ cwd: agent.cwd }).some(text => text.includes('Timed review:')),
      })
      const repeated = clock.advance()
      assert.equal(
        repeated.wakes,
        1,
      )
      assert.deepEqual(
        repeated.reasons,
        [],
      )
      clock.restart()
      await pnyx.restart()
      assert.deepEqual(
        clock.advance().reasons,
        [],
      )
      assert.equal(
        clock.advance().wakes,
        1,
      )
      s.pullRequest({
        number: 701,
        checks: '1 passed, 1 total',
        draft: false,
      })
      const merge = await until({
        what: 'the ready PR to ask the owner for a merge decision',
        check: () => s.task({ key: 'watch' }).asks?.find(ask => ask.kind === 'merge'),
      })
      await s.chat({ text: 'Keep the merge waiting for my decision.' })
      await until({
        what: 'Hydra to finish acknowledging the pending decision',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      const overdue = clock.advance({ ms: QUESTION_REMINDER_MS })
      assert.deepEqual(
        overdue.reasons,
        [],
      )
      assert.equal(
        overdue.wakes,
        1,
      )
      const reminder = s.state().hydraMessages?.find(message => message.actor === 'pnyx'
        && message.text.includes(merge.id))
      assert.ok(reminder)
      assert.ok(reminder.text.includes(url))
      const reminderEvent = s.events().find(event => event.id === reminder.id)
      assert.ok(reminderEvent)
      assert.deepEqual(
        eventReasons({
          state: s.state(),
          event: reminderEvent,
        }),
        [],
      )
      await pnyx.restart({
        whileStopped: async () => {
          await s.owner({
            args: [
              'link',
              'watch',
              '--url',
              url,
              '--remove',
            ],
          })
          await move({ column: parked })
          assert.deepEqual(
            clock.advance().reasons,
            [],
          )
          await move({ column: progress })
          assert.deepEqual(
            clock.advance().reasons,
            ['timed review'],
          )
          assert.equal(
            clock.advance().wakes,
            2,
          )
        },
      })
    } finally {
      clock.close()
    }
  },
)

test(
  'overdue owner questions get code reminders without a main wake or intervening events',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Choose a merge',
        '--key',
        'choice',
      ],
    })
    await s.owner({
      args: [
        'task',
        'ask',
        'choice',
        '--to',
        'owner',
        '--actor',
        'hydra',
        '--reason',
        'The owner chooses',
        '--question',
        'May I merge this change?',
        '--choice',
        'Merge',
        '--choice',
        'Hold',
      ],
    })
    const task = s.task({ key: 'choice' })
    const ask = task.asks?.[0]
    assert.ok(ask)
    const clock = reviewClock({
      s,
      at: Date.parse(ask.at),
    })

    try {
      assert.deepEqual(
        clock.advance({ ms: QUESTION_REMINDER_MS - REVIEW_MS }).reasons,
        [],
      )
      assert.equal(
        s.state().hydraMessages?.length ?? 0,
        0,
      )
      const due = clock.advance({ ms: REVIEW_MS + 1 })
      assert.equal(
        due.wakes,
        0,
      )
      assert.deepEqual(
        due.reasons,
        [],
      )
      const reminder = s.state().hydraMessages?.find(message => message.task === task.id)
      assert.ok(reminder)
      const reminderEvent = s.events().find(event => event.id === reminder.id)
      assert.ok(reminderEvent)
      assert.deepEqual(
        eventReasons({
          state: s.state(),
          event: reminderEvent,
        }),
        [],
      )
      assert.match(
        reminder.text,
        /May I merge this change\?/,
      )
      assert.ok(s.state().hydraReview?.reminders[`${task.id}:${ask.id}`])
      assert.equal(
        s.state().cards[HYDRA_CARD]?.agent,
        undefined,
      )
      clock.restart()
      clock.advance()
      assert.equal(
        s.state().hydraMessages?.length,
        1,
      )
      clock.advance({ ms: QUESTION_REMINDER_MS })
      assert.equal(
        s.state().hydraMessages?.length,
        2,
      )
      assert.equal(
        clock.advance().wakes,
        0,
      )
      await s.owner({
        args: [
          'task',
          'answer',
          'choice',
          ask.id,
          '--choice',
          'Hold',
        ],
      })
      const messages = s.state().hydraMessages?.length
      clock.advance({ ms: QUESTION_REMINDER_MS })
      assert.equal(
        s.state().hydraMessages?.length,
        messages,
      )
    } finally {
      clock.close()
    }
  },
)

test(
  'a due review with nothing to record takes no lock and waits a full period before it runs again',
  async t => {
    const s = await pnyx.scenario()
    let time = Date.now()
    const timer = startReviewTimer({
      hydraId: s.hydraId,
      now: () => time,
      interval: () => () => {},
      wake: () => {},
    })
    const lock = join(
      hydraDir({ hydraId: s.hydraId }),
      'writer.lock',
    )
    const open = fs.openSync
    let locks = 0
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's signature.
      (...args: Parameters<typeof fs.openSync>) => {
        if (args[0] === lock) {
          locks++
        }

        return open(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      timer.close()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const reviews = () => s.events().filter(event => event.type === 'hydra.review').length
    time += REVIEW_MS
    timer.check()
    assert.deepEqual(
      [
        locks,
        reviews(),
      ],
      [
        0,
        0,
      ],
    )
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Late work',
        '--key',
        'late',
      ],
    })
    locks = 0
    time += REVIEW_MS - 1
    timer.check()
    assert.equal(
      reviews(),
      0,
    )
    time += 1
    timer.check()
    assert.deepEqual(
      [
        reviews(),
        locks > 0,
      ],
      [
        1,
        true,
      ],
    )
  },
)
