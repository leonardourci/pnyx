import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { reduce } from '../src/core/reducer.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { fireReminders } from '../src/reminders/fire.ts'
import { reminderDeadline, waitingReminders } from '../src/reminders/state.ts'
import { reminderTime } from '../src/reminders/time.ts'

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

beforeEach(() => {
  previous = process.env.PNYX_HOME
  home = mkdtempSync(join(
    tmpdir(),
    'pnyx-reminders-',
  ))
  process.env.PNYX_HOME = home
  process.env.PNYX_SEMANTIC = 'off'
  commands.hydra([
    'create',
    hydraId,
  ])
  run({
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
  'CLI sets, replaces and clears reminders with idempotency and revision checks',
  async () => {
    assert.deepEqual(
      run({ args: ['reminders'] }),
      {
        hydraId,
        count: 0,
        reminders: 'none: no waiting reminders',
      },
    )
    const before = task().revision
    run({
      args: [
        'remind',
        'work',
        later,
        '--event-id',
        'first',
        '--if-revision',
        String(before),
      ],
    })
    assert.equal(
      task().reminder?.at,
      later,
    )
    assert.equal(
      task().reminder?.id,
      'first',
    )
    const seq = state().seq
    run({
      args: [
        'remind',
        'work',
        later,
        '--event-id',
        'first',
        '--if-revision',
        '0',
      ],
    })
    assert.equal(
      state().seq,
      seq,
    )
    assert.throws(
      () => run({
        args: [
          'remind',
          'work',
          'in 2 hours',
          '--if-revision',
          '0',
        ],
      }),
      /revision/,
    )
    assert.equal(
      (await run({ args: ['reminders'] })).count,
      1,
    )
    run({
      args: [
        'remind',
        'work',
        '2099-10-17T12:00:00Z',
      ],
    })
    assert.equal(
      task().reminder?.at,
      '2099-10-17T12:00:00.000Z',
    )
    run({
      args: [
        'remind',
        'work',
        'clear',
      ],
    })
    assert.equal(
      task().reminder,
      undefined,
    )
    assert.equal(
      reminderDeadline({ state: state() }),
      undefined,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: '2100-01-01T00:00:00Z',
      }),
      0,
    )
    assert.throws(
      () => run({
        args: [
          'remind',
          '$hydra',
          later,
        ],
      }),
      /Choose a task/,
    )
  },
)

test(
  'due events fire once, reveal hidden tasks, use column roles and notify Hydra once',
  async () => {
    const config = hydraConfig({
      state: state(),
      id: hydraId,
    })
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at: now,
            actor: 'test',
          },
          cardId: '$board',
          change: {
            type: 'board.columns',
            data: {
              columns: config.columns.map(column => column.role === 'needs_you' ? {
                ...column,
                id: 'custom:attention',
                title: 'Questions',
              } : column),
            },
          },
        })
        assert.ok('event' in decision); writer.append({ event: decision.event })
      },
    })
    run({
      args: [
        'remind',
        'work',
        later,
      ],
    })
    run({
      args: [
        'hide',
        'work',
      ],
    })
    assert.equal(
      fireReminders({
        hydraId,
        at: '2099-10-16T11:59:59.999Z',
      }),
      0,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      1,
    )
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      0,
    )
    assert.equal(
      task().column,
      'custom:attention',
    )
    assert.equal(
      task().hidden,
      false,
    )
    assert.equal(
      task().status?.state,
      'needs_you',
    )
    assert.match(
      task().status!.note,
      /Reminder: Review cursor pagination/,
    )
    assert.equal(
      task().reminder?.dueAt,
      later,
    )
    assert.equal(
      waitingReminders({ state: state() }).length,
      0,
    )
    const messages = state().hydraMessages!
    assert.equal(
      messages.length,
      1,
    )
    assert.equal(
      messages[0]?.actor,
      'hydra',
    )
    assert.equal(
      messages[0]?.task,
      task().id,
    )

    const due = readEvents({ hydraId }).find(event => event.type === 'task.reminder-due')!
    run({
      args: [
        'remind',
        'work',
        '2099-10-17T12:00:00Z',
      ],
    })
    const current = state()
    const stale = reduce({
      state: current,
      event: {
        ...due,
        seq: current.seq + 1,
        id: 'late-stale-due',
      },
    })
    assert.equal(
      stale.cards[task().id]?.reminder?.dueAt,
      undefined,
    )
    assert.equal(
      stale.hydraMessages?.length,
      1,
    )
  },
)

test(
  'an expanded-year reminder cannot delay a nearer due reminder',
  () => {
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
    run({
      args: [
        'remind',
        'work',
        far,
      ],
    })
    run({
      args: [
        'create',
        '--key',
        'near',
        '--title',
        'Near reminder',
      ],
    })
    run({
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
    assert.equal(
      fireReminders({
        hydraId,
        at: later,
      }),
      0,
    )
  },
)
