import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { loadHydra } from '#app/store.ts'
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
  },
)
