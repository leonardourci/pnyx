import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { startReviewTimer, REVIEW_MS } from '#hydra/review-timer.ts'
import { MINUTE_MS, QUESTION_REMINDER_MS } from '#hydra/review.ts'
import { eventReasons } from '#hydra/wake-reasons.ts'
import { taskMentions } from '#hydra/mentions.ts'
import { openPage, until } from '#test-harness/harness.ts'

// How many times one review is offered while Hydra keeps starting turns.
const REVIEW_ATTEMPTS = 5
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
    advance: async ({ ms = REVIEW_MS }: { ms?: number } = {}) => {
      time += ms
      const at = new Date(time).toISOString()
      const recorded = () => s.events().findLast(event => event.type === 'hydra.review')?.at === at

      // A review waits while Hydra works, and a wake may start one meanwhile; the server's poll tries again, as this does.
      for (let attempt = 0; attempt < REVIEW_ATTEMPTS && !recorded(); attempt++) {
        await until({
          what: 'Hydra to be idle before the review',
          check: () => s.state().cards[HYDRA_CARD]?.sessionActivity !== 'working',
        })
        await timer.check()
      }

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
    advanceDuringTurn: async ({ ms }: { ms: number }) => {
      time += ms
      await timer.check()
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
        (await clock.advance()).reasons,
        [],
      )
      assert.equal(
        (await clock.advance()).wakes,
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
      const memory = await clock.advance()
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
        (await clock.advance()).wakes,
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
      const first = await clock.advance()
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
      const repeated = await clock.advance()
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
        (await clock.advance()).reasons,
        [],
      )
      assert.equal(
        (await clock.advance()).wakes,
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
      const overdue = await clock.advance({ ms: QUESTION_REMINDER_MS })
      assert.deepEqual(
        overdue.reasons,
        [],
      )
      assert.equal(
        overdue.wakes,
        1,
      )
      const card = s.task({ key: 'watch' })
      const reminder = s.state().hydraMessages?.find(message => message.actor === 'pnyx'
        && message.text.startsWith('1 question waiting on you:')
        && taskMentions({ text: message.text }).some(mention => mention.id === card.id))
      assert.ok(reminder)
      assert.deepEqual(
        taskMentions({ text: reminder.text }).map(mention => mention.id),
        [card.id],
      )
      assert.equal(
        reminder.text.includes(merge.id),
        false,
      )
      assert.equal(
        reminder.text.includes(url),
        false,
      )
      const reminderEvent = s.events().find(event => event.id === reminder.id)
      assert.ok(reminderEvent)
      assert.deepEqual(
        eventReasons({
          state: s.state(),
          event: reminderEvent,
        }),
        [],
      )
      await pnyx.restart()
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
        (await clock.advance()).reasons,
        [],
      )
      await move({ column: progress })
      assert.deepEqual(
        (await clock.advance()).reasons,
        ['timed review'],
      )
      assert.equal(
        (await clock.advance()).wakes,
        2,
      )
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
        'Choose a merge strategy for the pagination endpoint and the new response schema before the rollout starts',
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
        'May I merge this change?\n\nPlease review the endpoint, the response schema, the cursor validation, the rollout notes and the compatibility checks before choosing Merge or Hold.',
        '--choice',
        'Merge',
        '--choice',
        'Hold',
      ],
    })
    const task = s.task({ key: 'choice' })
    const ask = task.asks?.[0]
    assert.ok(ask)
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'scheduled',
        '--title',
        'Review cursor examples',
      ],
    })
    await s.owner({
      args: [
        'task',
        'remind',
        'scheduled',
        new Date(Date.parse(ask.at) + QUESTION_REMINDER_MS + 1).toISOString(),
      ],
    })
    const hosted = await s.chat({ text: 'Prepare reminder supervision' })
    await until({
      what: 'Hydra to finish its initial turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    let baseline = s.state().hydraMessages?.length ?? 0
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const held = pnyx.claude.plan({
      text: 'Hold this reminder check',
      reply: 'The reminder check is ready.',
      hold: true,
    })
    const clock = reviewClock({
      s,
      at: Date.parse(ask.at),
    })

    try {
      assert.deepEqual(
        (await clock.advance({ ms: QUESTION_REMINDER_MS - REVIEW_MS })).reasons,
        [],
      )
      assert.equal(
        s.state().hydraMessages?.length ?? 0,
        baseline,
      )
      await s.chat({ text: 'Hold this reminder check' })
      await until({
        what: 'Hydra to hold its turn',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
      })
      baseline = s.state().hydraMessages?.length ?? 0
      const received = s.received({ cwd: hosted.cwd }).length
      await clock.advanceDuringTurn({ ms: REVIEW_MS + 1 })
      assert.equal(
        s.state().cards[HYDRA_CARD]?.sessionActivity,
        'working',
      )
      assert.equal(
        s.state().hydraMessages?.length,
        baseline + 1,
      )
      assert.equal(
        s.received({ cwd: hosted.cwd }).length,
        received,
      )
      const receipt = s.events().find(event => event.id === s.task({ key: 'scheduled' }).reminder?.dueEvent)
      assert.ok(receipt)
      assert.deepEqual(
        eventReasons({
          state: s.state(),
          event: receipt,
        }),
        [],
      )
      const grouped = s.state().hydraMessages?.find(entry => entry.reminderQuestions?.length)
      assert.ok(grouped)
      const groupedSeq = s.events().find(event => event.id === grouped.id)?.seq
      assert.ok(groupedSeq)
      await page.shows({
        what: 'the grouped message during the held turn',
        check: ({ state }) => state.seq >= groupedSeq,
      })
      assert.deepEqual(
        page.queue()?.waiting,
        [],
      )
      held.release()
      await until({
        what: 'Hydra to finish its held turn',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      assert.equal(
        s.received({ cwd: hosted.cwd }).length,
        received,
      )
      const due = await clock.advance({ ms: 0 })
      assert.equal(
        due.wakes,
        0,
      )
      assert.deepEqual(
        due.reasons,
        [],
      )
      const reminder = s.state().hydraMessages?.find(message => message.text.includes(`pnyx-task:${task.id}`))
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
        /1 question waiting on you:/,
      )
      assert.ok(!reminder.text.includes('May I merge this change?'))
      assert.equal(
        reminder.actor,
        'pnyx',
      )
      assert.ok(reminder.text.startsWith('- Reminder: '))
      assert.ok(reminder.text.split('\n').every(line => line.split(/\s+/).length <= 30))
      assert.ok(reminder.text.includes(`pnyx-task:${s.task({ key: 'scheduled' }).id}`))
      assert.equal(
        s.state().hydraMessages?.length,
        baseline + 1,
      )
      assert.equal(
        reminder.text.split('\n').length,
        2,
      )
      assert.ok(reminder.text.includes('…'))
      assert.ok(s.task({ key: 'choice' }).asks?.[0]?.question.includes('compatibility checks'))
      assert.ok(s.state().questionReminders?.[`${task.id}:${ask.id}`])
      assert.equal(
        s.state().cards[HYDRA_CARD]?.agent?.host,
        'pnyx',
      )
      clock.restart()
      await clock.advance()
      assert.equal(
        s.state().hydraMessages?.length,
        baseline + 1,
      )
      await clock.advance({ ms: QUESTION_REMINDER_MS })
      assert.equal(
        s.state().hydraMessages?.length,
        baseline + 2,
      )
      assert.equal(
        (await clock.advance()).wakes,
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
      // The answer goes to Hydra, and a review never runs while Hydra's turn does.
      await until({
        what: 'Hydra to finish its turn on the answer',
        check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      const messages = s.state().hydraMessages?.length
      await clock.advance({ ms: QUESTION_REMINDER_MS })
      assert.equal(
        s.state().hydraMessages?.length,
        messages,
      )
    } finally {
      held.release()
      page.close()
      clock.close()
    }
  },
)

test(
  'a stale left-off wakes an idle Hydra once and adds no review while it stays unchanged',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'hydra',
        'memory',
        'set',
        '--key',
        'left-off',
        '--text',
        'Pick up the icon work.',
      ],
    })
    const eightDays = 8 * 24 * 60 * 60 * 1000
    let time = Date.now() + eightDays
    let wakes = 0
    const timer = startReviewTimer({
      hydraId: s.hydraId,
      now: () => time,
      interval: () => () => {},
      wake: () => wakes++,
    })
    const reviews = () => s.events().filter(event => event.type === 'hydra.review')

    try {
      time += REVIEW_MS
      await timer.check()
      assert.match(
        reviews().at(-1)?.data.block ?? '',
        /stale left-off: Hydra memory `left-off` is over 7 days old/,
      )
      assert.equal(
        wakes,
        1,
      )
      time += REVIEW_MS
      await timer.check()
      assert.deepEqual(
        [
          reviews().length,
          wakes,
        ],
        [
          1,
          1,
        ],
      )
    } finally {
      timer.close()
    }
  },
)

test(
  'a due review with nothing to record writes nothing and waits a full period before it runs again',
  async t => {
    const s = await pnyx.scenario()
    let time = Date.now()
    const timer = startReviewTimer({
      hydraId: s.hydraId,
      now: () => time,
      interval: () => () => {},
      wake: () => {},
    })
    t.after(() => timer.close())
    const reviews = () => s.events().filter(event => event.type === 'hydra.review').length
    time += REVIEW_MS
    await timer.check()
    assert.equal(
      reviews(),
      0,
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
    time += REVIEW_MS - 1
    await timer.check()
    assert.equal(
      reviews(),
      0,
    )
    time += 1
    await timer.check()
    assert.equal(
      reviews(),
      1,
    )
  },
)

test(
  'the review cadence follows the setting every Hydra shares, and 0 turns timed reviews off',
  async () => {
    const s = await pnyx.scenario()
    const before = /reviewMinutes: (\d+)/.exec(await s.owner({
      args: [
        'settings',
        'show',
      ],
    }))![1]!
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
    await s.owner({
      args: [
        'settings',
        'set',
        '--json',
        '{"reviewMinutes":10}',
      ],
    })
    let time = Date.now()
    const timer = startReviewTimer({
      hydraId: s.hydraId,
      now: () => time,
      interval: () => () => {},
      wake: () => {},
    })
    const reviews = () => s.events().filter(event => event.type === 'hydra.review').length

    try {
      time += 10 * MINUTE_MS - 1
      await timer.check()
      assert.equal(
        reviews(),
        0,
      )
      time += 1
      await timer.check()
      assert.equal(
        reviews(),
        1,
      )
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          '{"reviewMinutes":0}',
        ],
      })
      time += 2 * REVIEW_MS
      await timer.check()
      assert.equal(
        reviews(),
        1,
      )
    } finally {
      timer.close()
      // Every flow shares one Pnyx home, so later flows keep the cadence they started with.
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ reviewMinutes: Number(before) }),
        ],
      })
    }
  },
)

test(
  'starting a worker clears its recurring reminder without another reminder poll',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'reminder-work' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'reminder-work',
        '--title',
        'Review synthetic schema',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'remind',
        'reminder-work',
        'in 1 hour',
        '--every',
        '4 hours',
        '--until',
        'worker-started',
      ],
    })
    assert.ok(s.task({ key: 'reminder-work' }).reminder)
    await s.owner({
      args: [
        'task',
        'start',
        'reminder-work',
        '--harness',
        'claude',
        '--prompt',
        'Review the synthetic schema',
      ],
    })
    assert.equal(
      s.task({ key: 'reminder-work' }).reminder,
      undefined,
    )
  },
)
