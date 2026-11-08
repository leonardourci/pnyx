import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import { lookupMessages, type MessageSelection } from './message-lookup.ts'
import { lookupEvents } from '#hydra/fixtures/message-lookup.ts'

const read = ({
  selection = {},
  events = lookupEvents,
  card,
}: {
  selection?: MessageSelection
  events?: HydraEvent[]
  card?: string
} = {}) => lookupMessages({
  hydraId: 'fixture',
  card,
  events,
  snapshot: events.at(-1)?.seq ?? 0,
  selection,
})
const sequences = ({ page }: { page: ReturnType<typeof read> }) =>
  page.messages.map(message => message.seq)

test(
  'id, sequence and time select the same whole message with surroundings',
  () => {
    for (const selector of [
      { id: 'original:4:m0' },
      { id: 'event-5' },
      { seq: 5 },
      { at: '2025-12-31T21:00:04-03:00' },
    ]) {
      const page = read({
        selection: {
          ...selector,
          before: 2,
          after: 1,
        },
      })
      assert.deepEqual(
        sequences({ page }),
        [
          3,
          4,
          5,
          6,
        ],
      )
      assert.equal(
        page.anchor,
        'original:4:m0',
      )
      assert.ok(page.older)
      assert.ok(page.newer)
    }

    assert.deepEqual(
      sequences({ page: read({ selection: { seq: 1 } }) }),
      [1],
    )
    assert.deepEqual(
      read({ events: [] }).messages,
      [],
    )
    const leapDay = read({
      events: [
        {
          ...lookupEvents[0],
          at: '2024-02-29T23:30:00Z',
        },
      ],
      selection: { at: '2024-03-01T00:30:00+01:00' },
    })
    assert.equal(
      leapDay.messages[0].at,
      '2024-02-29T23:30:00Z',
    )
  },
)

test(
  'older and newer cursors resume without overlaps and freeze the snapshot',
  () => {
    const center = read({ selection: { seq: 5 } })
    const older = read({
      selection: {
        cursor: center.older,
        limit: 2,
      },
    })
    assert.deepEqual(
      sequences({ page: older }),
      [
        3,
        4,
      ],
    )
    assert.deepEqual(
      sequences({
        page: read({
          selection: {
            cursor: older.older,
            limit: 2,
          },
        }),
      }),
      [
        1,
        2,
      ],
    )
    assert.deepEqual(
      sequences({
        page: read({
          selection: {
            cursor: older.newer,
            limit: 2,
          },
        }),
      }),
      [
        5,
        6,
      ],
    )
    const newer = read({
      selection: {
        cursor: center.newer,
        limit: 2,
      },
    })
    assert.deepEqual(
      sequences({ page: newer }),
      [
        6,
        7,
      ],
    )
    const appended = [
      ...lookupEvents,
      {
        ...lookupEvents[0],
        id: 'later',
        data: {
          ...lookupEvents[0].data,
          nativeId: 'later:m0',
          text: 'A later harvested reply.',
        },
        seq: 10,
        at: '2025-12-31T00:00:00Z',
      },
    ]
    assert.deepEqual(
      sequences({
        page: read({
          events: appended,
          selection: { cursor: newer.newer },
        }),
      }),
      [
        8,
        9,
      ],
    )
    assert.equal(
      read({ selection: { cursor: newer.newer } }).newer,
      undefined,
    )
    assert.equal(
      read({
        events: appended,
        selection: { cursor: newer.newer },
      }).snapshot,
      9,
    )

    assert.deepEqual(
      sequences({
        page: read({
          selection: {
            seq: 5,
            direction: 'older',
            limit: 2,
          },
        }),
      }),
      [
        3,
        4,
      ],
    )
    assert.deepEqual(
      sequences({
        page: read({
          selection: {
            seq: 5,
            direction: 'newer',
            limit: 2,
          },
        }),
      }),
      [
        6,
        7,
      ],
    )
  },
)

test(
  'inclusive ranges page in both directions and preserve their boundaries',
  () => {
    for (const range of [
      {
        from: '3',
        to: '7',
      },
      {
        from: lookupEvents[2].at,
        to: lookupEvents[6].at,
      },
    ]) {
      const first = read({
        selection: {
          ...range,
          limit: 2,
        },
      })
      assert.deepEqual(
        sequences({ page: first }),
        [
          3,
          4,
        ],
      )
      const next = read({
        selection: {
          cursor: first.newer,
          limit: 2,
        },
      })
      assert.deepEqual(
        sequences({ page: next }),
        [
          5,
          6,
        ],
      )
      assert.deepEqual(
        sequences({ page: read({ selection: { cursor: next.newer } }) }),
        [7],
      )
      const last = read({
        selection: {
          ...range,
          direction: 'older',
          limit: 2,
        },
      })
      assert.deepEqual(
        sequences({ page: last }),
        [
          6,
          7,
        ],
      )
      assert.deepEqual(
        sequences({ page: read({ selection: { cursor: last.older } }) }),
        [
          3,
          4,
          5,
        ],
      )
    }

    const delayed = [
      ...lookupEvents,
      {
        ...lookupEvents[0],
        id: 'harvested',
        data: {
          ...lookupEvents[0].data,
          nativeId: 'late:m0',
        },
        seq: 10,
        at: '2025-12-31T00:00:00Z',
      },
    ]
    assert.deepEqual(
      sequences({
        page: read({
          events: delayed,
          selection: {
            from: '9',
            to: '10',
          },
        }),
      }),
      [
        10,
        9,
      ],
    )
  },
)

test(
  'budgets bound escaped output and never cut a message or transport part',
  () => {
    const chunk: HydraEvent = {
      ...lookupEvents[0],
      data: {
        ...lookupEvents[0].data,
        nativeId: '42:m0.0',
        messageId: '42:m0',
        part: 0,
        text: 'first half ',
      },
    } as HydraEvent
    const tail: HydraEvent = {
      ...chunk,
      seq: 2,
      id: 'tail',
      data: {
        ...chunk.data,
        nativeId: '42:m0.11',
        part: 11,
        text: 'second half',
      },
    } as HydraEvent
    const joined = read({
      events: [
        chunk,
        tail,
      ],
      selection: { seq: 2 },
    })
    assert.equal(
      joined.messages.length,
      1,
    )
    assert.equal(
      joined.messages[0].text,
      'first half second half',
    )
    assert.equal(
      joined.messages[0].id,
      'original:42:m0',
    )
    const tailRange = read({
      events: [
        chunk,
        tail,
      ],
      selection: {
        from: '2',
        to: '2',
      },
    })
    assert.equal(
      tailRange.messages[0].text,
      'first half second half',
    )
    const duplicate = read({
      events: [
        chunk,
        tail,
        {
          ...tail,
          id: 'duplicate-tail',
          seq: 3,
        },
      ],
    })
    assert.equal(
      duplicate.messages.length,
      1,
    )
    assert.equal(
      duplicate.messages[0].text,
      'first half second half',
    )

    const budgeted = read({
      selection: {
        seq: 5,
        budget: 20,
      },
    })
    assert.ok(budgeted.messages.some(message => message.seq === 5))
    assert.ok(budgeted.messages.length > 1)
    assert.ok(budgeted.tokens <= 20)
    const escaped = lookupEvents.map(event => ({
      ...event,
      data: {
        ...event.data,
        text: '\n"\\'.repeat(1500),
      },
    })) as HydraEvent[]
    const page = read({
      events: escaped,
      selection: { budget: 99999 },
    })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 24000)
    assert.equal(
      page.messages[0].text,
      '\n"\\'.repeat(1500),
    )
    assert.ok(page.newer)
    assert.throws(
      () => read({
        events: [
          {
            ...escaped[0],
            data: {
              ...escaped[0].data,
              text: 'x'.repeat(30000),
            },
          } as HydraEvent,
        ],
      }),
      { code: 'MESSAGE_TOO_LARGE' },
    )
  },
)

test(
  'invalid, ambiguous and wrong-thread references fail explicitly',
  () => {
    for (const selection of [
      { seq: 99 },
      { id: 'missing' },
    ]) {
      assert.throws(
        () => read({ selection }),
        { code: 'NOT_FOUND' },
      )
    }

    const duplicateTime = [
      ...lookupEvents,
      {
        ...lookupEvents[0],
        id: 'another',
        seq: 10,
        data: {
          ...lookupEvents[0].data,
          session: 'other',
        },
      } as HydraEvent,
    ]
    assert.throws(
      () => read({
        events: duplicateTime,
        selection: { at: lookupEvents[0].at },
      }),
      { code: 'CONFLICT' },
    )

    for (const selection of [
      { at: '01/01/2026' },
      { at: '2026-02-30T00:00:00Z' },
      { at: '2026-02-29T00:00:00Z' },
      { from: '2026-02-30T00:00:00Z' },
      { to: '2026-02-30T00:00:00Z' },
      { at: '2026-01-01T24:00:00Z' },
      { from: '2026-01-01T24:00:00Z' },
      { seq: -1 },
      {
        seq: 1,
        id: 'event-1',
      },
      {
        seq: 1,
        direction: 'sideways',
      },
      { before: 1 },
      {
        from: '7',
        to: '3',
      },
      { cursor: 'broken' },
    ]) {
      assert.throws(
        () => read({ selection }),
        { code: 'VALIDATION_ERROR' },
      )
    }

    const cursor = read({ selection: { seq: 5 } }).older!
    assert.throws(
      () => read({
        card: 'task-fixture',
        selection: { cursor },
      }),
      { code: 'VALIDATION_ERROR' },
    )
    assert.throws(
      () => lookupMessages({
        hydraId: 'another',
        events: lookupEvents,
        snapshot: 9,
        selection: { cursor },
      }),
      { code: 'VALIDATION_ERROR' },
    )
    assert.throws(
      () => read({
        selection: {
          cursor,
          seq: 1,
        },
      }),
      { code: 'VALIDATION_ERROR' },
    )
  },
)

test(
  'task replies retain the authority of their recorded actor',
  () => {
    const events: HydraEvent[] = [
      {
        ...lookupEvents[0],
        type: 'card.replied',
        cardId: 'task-fixture',
        actor: 'web',
        data: {
          reply: 'owner',
          state: 'delivered',
          route: 'pnyx',
          text: 'Owner instruction.',
        },
      },
      {
        ...lookupEvents[1],
        type: 'card.replied',
        cardId: 'task-fixture',
        actor: 'hydra',
        data: {
          reply: 'hydra',
          state: 'delivered',
          route: 'pnyx',
          text: 'Hydra instruction.',
        },
      },
      {
        ...lookupEvents[2],
        type: 'card.replied',
        cardId: 'task-fixture',
        actor: 'worker:sample',
        data: {
          reply: 'worker',
          state: 'delivered',
          route: 'pnyx',
          text: 'Worker instruction.',
        },
      },
    ]
    const page = read({
      card: 'task-fixture',
      events,
    })
    assert.deepEqual(
      page.messages.map(message => ({
        id: message.id,
        role: message.role,
      })),
      [
        {
          id: 'reply:owner',
          role: 'owner',
        },
        {
          id: 'reply:hydra',
          role: 'hydra',
        },
        {
          id: 'reply:worker',
          role: 'worker:sample',
        },
      ],
    )
  },
)
