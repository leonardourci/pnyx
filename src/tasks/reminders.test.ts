import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents, readLog } from '#app/event-log.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { readSnapshot } from '#app/snapshot.ts'
import { hydraConversation } from '#hydra/conversation.ts'
import { taskMentions } from '#hydra/mentions.ts'
import { fireReminders } from './fire-reminders.ts'
import { reminderDeadline, waitingReminders } from './reminders.ts'
import { reminderTime } from './time.ts'

const hydraId = 'reminders'
const now = '2026-10-15T12:00:00.000Z'
const later = '2099-10-16T12:00:00.000Z'
let home: string
let previous: string | undefined
const state = () => loadHydra({ hydraId }).state
const task = () => state().cards[state().keys.work!]!
const run = ({ args }: { args: string[] }) => commands.task([
  ...args,
  '--hydra',
  hydraId,
])

beforeEach(async () => {
  previous = process.env.PNYX_HOME
  home = mkdtempSync(join(
    tmpdir(),
    'pnyx-reminders-',
  ))
  process.env.PNYX_HOME = home
  await commands.hydra([
    'create',
    hydraId,
  ])
  await run({
    args: [
      'create',
      '--key',
      'work',
      '--title',
      'Review cursor pagination',
    ],
  })
})

afterEach(() => {
  if (previous === undefined) {
    delete process.env.PNYX_HOME
  } else {
    process.env.PNYX_HOME = previous
  }

  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
})

test(
  'reminder times are explicit, future, timezone-aware, and tomorrow means local 9:00',
  () => {
    assert.equal(
      reminderTime({
        when: '2026-10-16T09:00:00-03:00',
        now,
      }),
      '2026-10-16T12:00:00.000Z',
    )
    assert.equal(
      reminderTime({
        when: 'in 2 hours',
        now,
      }),
      '2026-10-15T14:00:00.000Z',
    )
    const expected = new Date(now)
    expected.setDate(expected.getDate() + 1); expected.setHours(
      9,
      0,
      0,
      0,
    )
    assert.equal(
      reminderTime({
        when: 'tomorrow',
        now,
      }),
      expected.toISOString(),
    )
    expected.setHours(
      15,
      30,
      0,
      0,
    )
    assert.equal(
      reminderTime({
        when: 'tomorrow at 15:30',
        now,
      }),
      expected.toISOString(),
    )

    for (const when of [
      '2027-02-30T12:00Z',
      'yesterday',
      now,
      '2026-10-14T12:00Z',
      '2026-10-16T09:00',
      'tomorrow 25:00',
      'in 0 hours',
      'in 999999999999999999 days',
    ]) {
      assert.throws(
        () => reminderTime({
          when,
          now,
        }),
        /future reminder time/,
      )
    }
  },
)

test(
  'an expanded-year reminder cannot delay a nearer due reminder',
  async () => {
    const far = reminderTime({
      when: 'in 4000000 days',
      now,
    })
    assert.match(
      far,
      /^\+/,
    )
    assert.equal(
      reminderTime({
        when: far,
        now,
      }),
      far,
    )
    await run({
      args: [
        'remind',
        'work',
        far,
      ],
    })
    await run({
      args: [
        'create',
        '--key',
        'near',
        '--title',
        'Review the pagination cursor before publishing the new endpoint and confirm the response fields with the API owner',
      ],
    })
    await run({
      args: [
        'remind',
        'near',
        later,
      ],
    })
    assert.deepEqual(
      waitingReminders({ state: state() }).map(reminder => reminder.at),
      [
        later,
        far,
      ],
    )
    assert.equal(
      reminderDeadline({ state: state() }),
      Date.parse(later),
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      1,
    )
    assert.equal(
      state().cards[state().keys.near!]?.reminder?.dueAt,
      later,
    )
    assert.equal(
      task().reminder?.dueAt,
      undefined,
    )
    const reminder = state().hydraMessages?.at(-1)
    assert.ok(reminder)
    assert.equal(
      reminder.actor,
      'pnyx',
    )
    assert.ok(reminder.text.startsWith('- Reminder: '))
    assert.ok(reminder.text.split(/\s+/).length <= 30)
    assert.equal(
      taskMentions({ text: reminder.text })[0]?.id,
      state().keys.near,
    )
    const messages = await commands.hydra([
      'messages',
      '--hydra',
      hydraId,
    ])
    assert.ok(Array.isArray(messages.messages))
    assert.equal(
      messages.messages.at(-1)?.actor,
      'pnyx',
    )
    const conversation = hydraConversation({
      messages: state().hydraMessages ?? [],
      transcript: [],
      actions: [],
      columns: [],
      working: false,
      thinking: false,
    })
    assert.equal(
      conversation.entries.at(-1)?.role,
      'Pnyx',
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      0,
    )
    await run({
      args: [
        'create',
        '--key',
        'limit',
        '--title',
        'Review the last supported date',
      ],
    })
    await run({
      args: [
        'remind',
        'limit',
        '+275760-09-13T00:00:00.000Z',
        '--every',
        '1 hour',
        '--until',
        'task-done',
      ],
    })
    assert.doesNotThrow(() => fireReminders({
      hydraId,
      at: '+275760-09-13T00:00:00.000Z',
    }))
    assert.equal(
      state().cards[state().keys.limit!]?.reminder?.repeat,
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '+275760-09-13T00:00:00.000Z',
      }),
      0,
    )
  },
)

test(
  'recurring reminders skip missed intervals, survive replay and stop on recorded lifecycle facts',
  async t => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2099-10-16T11:00:00Z'),
    })
    await run({
      args: [
        'status',
        'work',
        'paused',
        '--note',
        'Waiting for a review slot',
      ],
    })
    await run({
      args: [
        'remind',
        'work',
        later,
        '--every',
        '1 hour',
        '--until',
        'worker-started',
      ],
    })
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      1,
    )
    assert.equal(
      task().reminder?.at,
      '2099-10-16T13:00:00.000Z',
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      0,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T15:30:00.000Z',
      }),
      1,
    )
    assert.equal(
      task().reminder?.at,
      '2099-10-16T16:00:00.000Z',
    )
    const replayed = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId }),
    })
    assert.deepEqual(
      replayed.cards[replayed.keys.work!]?.reminder,
      task().reminder,
    )
    assert.equal(
      state().hydraMessages?.length,
      2,
    )
    t.mock.timers.tick(5 * 60 * 60 * 1000)
    await run({
      args: [
        'status',
        'work',
        'working',
        '--note',
        'Worker started the review',
      ],
    })
    assert.equal(
      task().reminder,
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-17T12:00:00Z',
      }),
      0,
    )
    await run({
      args: [
        'remind',
        'work',
        '2099-10-17T12:00:00Z',
        '--every',
        '2 hours',
        '--until',
        'task-done',
      ],
    })
    await run({
      args: [
        'status',
        'work',
        'done',
        '--note',
        'Review finished',
      ],
    })
    assert.equal(
      task().reminder,
      undefined,
    )
    assert.equal(
      state().config?.columns.find(column => column.id === task().column)?.role,
      'done',
    )
    await run({
      args: [
        'create',
        '--key',
        'choice',
        '--title',
        'Choose a response format',
      ],
    })
    await run({
      args: [
        'ask',
        'choice',
        '--to',
        'owner',
        '--question',
        'Which response format?',
        '--actor',
        'hydra',
        '--reason',
        'The owner chooses the response',
        '--choice',
        'Compact',
        '--choice',
        'Expanded',
      ],
    })
    const question = state().cards[state().keys.choice!]?.asks?.[0]
    assert.ok(question)
    await run({
      args: [
        'remind',
        'choice',
        '2099-10-17T12:00:00Z',
        '--every',
        '4 hours',
        '--until',
        'question-answered',
        '--question',
        question.id,
      ],
    })
    await run({
      args: [
        'answer',
        'choice',
        question.id,
        '--choice',
        'Compact',
      ],
    })
    assert.equal(
      state().cards[state().keys.choice!]?.reminder,
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-18T12:00:00Z',
      }),
      0,
    )
    await run({
      args: [
        'ask',
        'choice',
        '--to',
        'owner',
        '--actor',
        'hydra',
        '--reason',
        'A replacement decision',
        '--question',
        'Keep the optional field?',
        '--choice',
        'Yes',
        '--choice',
        'No',
      ],
    })
    const closed = state().cards[state().keys.choice!]?.asks?.at(-1)
    assert.ok(closed)
    await run({
      args: [
        'remind',
        'choice',
        '2099-10-17T12:00:00Z',
        '--every',
        '4 hours',
        '--until',
        'question-answered',
        '--question',
        closed.id,
      ],
    })
    await run({
      args: [
        'close-question',
        'choice',
        closed.id,
        '--actor',
        'hydra',
        '--reason',
        'The choice is superseded',
        '--evidence',
        'The synthetic specification removed the field',
      ],
    })
    assert.equal(
      state().cards[state().keys.choice!]?.reminder,
      undefined,
    )
    const afterClose = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId }),
    })
    assert.equal(
      afterClose.cards[afterClose.keys.choice!]?.reminder,
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-18T12:00:00Z',
      }),
      0,
    )
  },
)

test(
  'invalid recurrence options leave the saved reminder unchanged',
  async () => {
    await run({
      args: [
        'remind',
        'work',
        later,
      ],
    })
    const before = task().reminder
    await assert.rejects(
      run({
        args: [
          'remind',
          'work',
          later,
          '--every',
          '0 hours',
          '--until',
          'task-done',
        ],
      }),
      /positive interval/,
    )
    await assert.rejects(
      run({
        args: [
          'remind',
          'work',
          later,
          '--every',
          '1 hour',
        ],
      }),
      /--until/,
    )
    await assert.rejects(
      run({
        args: [
          'remind',
          'work',
          later,
          '--until',
          'task-done',
        ],
      }),
      /--every/,
    )
    await assert.rejects(
      run({
        args: [
          'remind',
          'work',
          later,
          '--every',
          '1 hour',
          '--until',
          'question-answered',
          '--question',
          'missing',
        ],
      }),
      /open owner question/,
    )
    await assert.rejects(
      run({
        args: [
          'remind',
          'work',
          'clear',
          '--every',
          '1 hour',
          '--until',
          'task-done',
        ],
      }),
      /clear/,
    )
    assert.deepEqual(
      task().reminder,
      before,
    )
  },
)

test(
  'reminders due together persist one grouped chat message with separate task receipts',
  async t => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2099-10-16T08:00:00Z'),
    })
    await run({
      args: [
        'create',
        '--key',
        'other',
        '--title',
        'Review schema examples',
      ],
    })
    await run({
      args: [
        'remind',
        'work',
        later,
      ],
    })
    await run({
      args: [
        'remind',
        'other',
        later,
      ],
    })
    await run({
      args: [
        'ask',
        'work',
        '--to',
        'owner',
        '--actor',
        'hydra',
        '--reason',
        'The owner chooses',
        '--question',
        'Publish the cursor schema?',
        '--choice',
        'Yes',
        '--choice',
        'No',
      ],
    })
    const ask = task().asks?.[0]
    assert.ok(ask)
    const questionKey = `${task().id}:${ask.id}`
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      3,
    )
    assert.equal(
      state().hydraMessages?.length,
      1,
    )
    const message = state().hydraMessages?.[0]
    assert.ok(message)
    assert.equal(
      message.text.split('\n').length,
      2,
    )
    assert.equal(
      taskMentions({ text: message.text }).length,
      2,
    )
    assert.equal(
      readEvents({ hydraId }).filter(event => event.type === 'task.reminder-due').length,
      2,
    )
    const dir = join(
      home,
      'hydras',
      hydraId,
    )
    const batch = readLog({ dir })?.transactions.at(-1)
    assert.ok(batch)
    assert.equal(
      batch.events.filter(event => event.type === 'task.reminder-due').length,
      2,
    )
    const posted = batch.events.find(event => event.type === 'hydra.message')
    assert.ok(posted?.type === 'hydra.message')
    assert.deepEqual(
      posted.data.reminderQuestions,
      [questionKey],
    )
    assert.equal(
      state().questionReminders?.[questionKey],
      later,
    )
    const complete = readFileSync(join(
      dir,
      'events.jsonl',
    ))
    const tornDir = mkdtempSync(join(
      home,
      'torn-reminders-',
    ))
    writeFileSync(
      join(
        tornDir,
        'events.jsonl',
      ),
      complete.subarray(
        0,
        complete.length - 2,
      ),
    )
    const torn = readLog({ dir: tornDir })
    assert.ok(torn)
    const pending = replay({
      state: emptyHydra(),
      events: torn.events,
    })
    assert.equal(
      pending.hydraMessages?.length ?? 0,
      0,
    )
    assert.equal(
      pending.questionReminders,
      undefined,
    )
    assert.equal(
      pending.cards[pending.keys.work!]?.reminder?.dueAt,
      undefined,
    )
    assert.equal(
      pending.cards[pending.keys.other!]?.reminder?.dueAt,
      undefined,
    )
    const messages = await commands.hydra([
      'messages',
      '--hydra',
      hydraId,
    ])
    assert.ok(Array.isArray(messages.messages))
    assert.equal(
      messages.messages.length,
      1,
    )
    const replayed = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId }),
    })
    assert.deepEqual(
      replayed.hydraMessages,
      state().hydraMessages,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      0,
    )
    assert.equal(
      state().hydraMessages?.length,
      1,
    )
  },
)

test(
  'owner questions keep their four-hour clock across replay and stop after an answer',
  async t => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2099-10-16T11:00:00Z'),
    })
    await run({
      args: [
        'ask',
        'work',
        '--to',
        'owner',
        '--actor',
        'hydra',
        '--reason',
        'The owner chooses',
        '--question',
        'Build the proposal?',
        '--choice',
        'Yes',
        '--choice',
        'No',
      ],
    })
    const ask = task().asks?.[0]
    assert.ok(ask)
    await run({
      args: [
        'remind',
        'work',
        '2099-10-16T15:00:00.000Z',
        '--every',
        '4 hours',
        '--until',
        'question-answered',
        '--question',
        ask.id,
      ],
    })
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T14:59:59.999Z',
      }),
      0,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T15:00:00.000Z',
      }),
      2,
    )
    assert.equal(
      state().hydraMessages?.[0]?.text.split('\n').length,
      1,
    )
    const replayed = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId }),
    })
    assert.deepEqual(
      replayed.questionReminders,
      state().questionReminders,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T15:00:00.000Z',
      }),
      0,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T18:59:59.999Z',
      }),
      0,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T19:00:00.000Z',
      }),
      2,
    )
    t.mock.timers.tick(8 * 60 * 60 * 1000)
    await run({
      args: [
        'answer',
        'work',
        ask.id,
        '--choice',
        'No',
      ],
    })
    const ended = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId }),
    })
    assert.equal(
      ended.cards[ended.keys.work!]?.reminder,
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-17T12:00:00.000Z',
      }),
      0,
    )
  },
)

test(
  'repeated reminders preserve newer declarations and stop on recorded merged completion',
  async t => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2099-10-16T11:00:00Z'),
    })
    await run({
      args: [
        'status',
        'work',
        'paused',
        '--note',
        'Original wait',
      ],
    })
    await run({
      args: [
        'remind',
        'work',
        later,
        '--every',
        '1 hour',
        '--until',
        'task-done',
      ],
    })
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      1,
    )
    t.mock.timers.tick(60 * 60 * 1000)
    await run({
      args: [
        'status',
        'work',
        'blocked',
        '--note',
        'New validation failure',
      ],
    })
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T13:00:00.000Z',
      }),
      1,
    )
    await run({
      args: [
        'remind',
        'work',
        'clear',
      ],
    })
    assert.equal(
      task().status?.state,
      'blocked',
    )
    assert.equal(
      task().status?.note,
      'New validation failure',
    )
    await run({
      args: [
        'remind',
        'work',
        '2099-10-16T14:00:00.000Z',
        '--every',
        '1 hour',
        '--until',
        'task-done',
      ],
    })
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T14:00:00.000Z',
      }),
      1,
    )
    await commands.link([
      'work',
      '--hydra',
      hydraId,
      '--url',
      'https://github.com/example/schema/pull/1',
      '--kind',
      'github_pr',
      '--state',
      'merged',
    ])
    assert.equal(
      task().reminder,
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T15:00:00.000Z',
      }),
      0,
    )
  },
)

test(
  'a legacy reminder snapshot is rebuilt before restoring the prior task status',
  async () => {
    await run({
      args: [
        'status',
        'work',
        'paused',
        '--note',
        'Waiting before the reminder',
      ],
    })
    await run({
      args: [
        'remind',
        'work',
        later,
      ],
    })
    const dueId = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const card = writer.state.cards[writer.state.keys.work!]!
        const column = writer.state.config?.columns.find(column => column.role === 'needs_you')
        assert.ok(column)
        assert.ok(card.reminder)
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at: later,
            actor: 'pnyx',
          },
          cardId: card.id,
          change: {
            type: 'task.reminder-due',
            data: {
              reminder: card.reminder.id,
              column: column.id,
              message: {
                task: card.id,
                hydra: 'hydra',
                action: 'send',
                text: 'Reminder: Review synthetic pagination',
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })

        return decision.event.id
      },
    })
    const snapshot = join(
      home,
      'hydras',
      hydraId,
      'snapshot.json',
    )
    const legacy = readSnapshot({
      dir: join(
        home,
        'hydras',
        hydraId,
      ),
    })
    assert.ok(legacy)
    const message = legacy.state.hydraMessages?.[0]
    const card = legacy.state.cards[legacy.state.keys.work!]
    assert.ok(message)
    assert.ok(card?.reminder)
    legacy.rules = 20
    message.actor = 'hydra'
    delete card.reminder.dueEvent
    delete card.reminder.resume
    writeFileSync(
      snapshot,
      JSON.stringify(legacy),
    )
    assert.equal(
      state().hydraMessages?.[0]?.actor,
      'pnyx',
    )
    assert.equal(
      task().reminder?.dueEvent,
      dueId,
    )
    await run({
      args: [
        'remind',
        'work',
        'clear',
      ],
    })
    assert.equal(
      task().status?.state,
      'paused',
    )
    assert.equal(
      task().status?.note,
      'Waiting before the reminder',
    )
  },
)
