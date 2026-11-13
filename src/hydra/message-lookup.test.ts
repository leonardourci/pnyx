import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import { lookupMessages, type MessageSelection } from './message-lookup.ts'
import type { SessionEntry } from './transcripts-read.ts'
import { lookupEntries, lookupEvents } from '#hydra/fixtures/message-lookup.ts'

const read = ({
  selection = {},
  events = lookupEvents,
  entries = lookupEntries,
  snapshot = 9,
  card,
  hydraId = 'fixture',
}: {
  selection?: MessageSelection
  events?: HydraEvent[]
  entries?: SessionEntry[]
  snapshot?: number
  card?: string
  hydraId?: string
}) => lookupMessages({
  hydraId,
  card,
  events,
  entries,
  snapshot,
  selection,
})
const sequences = ({ page }: { page: ReturnType<typeof read> }) =>
  page.messages.map(message => message.seq)

test(
  'native replies take the seq of the first event after them and rejoin their parts, and task replies keep their actor',
  () => {
    const second = {
      ...lookupEntries[4],
      id: '4:m1',
      reference: 'original:4:m1',
      text: 'A second reply before the same event.',
      at: '2026-01-01T00:00:03.750Z',
    }
    const sameTime = {
      ...lookupEntries[3],
      id: '3:m1',
      reference: 'original:3:m1',
      text: 'A reply at the same time as its event.',
      at: '2026-01-01T00:00:03.000Z',
    }
    const entries = [
      ...lookupEntries,
      second,
      sameTime,
    ]
    assert.deepEqual(
      read({
        entries,
        selection: { id: second.reference },
      }).messages.map(message => [
        message.seq,
        message.text,
      ]),
      [
        [
          5,
          'A second reply before the same event.',
        ],
      ],
    )
    assert.deepEqual(
      read({
        entries,
        selection: { id: sameTime.reference },
      }).messages.map(message => message.seq),
      [5],
    )
    assert.throws(
      () => read({
        entries,
        selection: { seq: 5 },
      }),
      /Several messages match; use --id/,
    )
    assert.deepEqual(
      read({ snapshot: 2 }).messages.map(message => message.text),
      [
        'Recorded reply 1.',
        'Recorded reply 2.',
      ],
    )

    const part = {
      ...lookupEntries[0],
      reference: 'original:42:m0',
      messageId: '42:m0',
    }
    assert.deepEqual(
      read({
        entries: [
          {
            ...part,
            id: '42:m0.11',
            part: 11,
            text: 'second half',
          },
          {
            ...part,
            id: '42:m0.0',
            part: 0,
            text: 'first half ',
          },
        ],
      }).messages.map(message => [
        message.id,
        message.text,
      ]),
      [
        [
          'original:42:m0',
          'first half second half',
        ],
      ],
    )

    const reply = ({
      event,
      actor,
      id,
    }: {
      event: HydraEvent
      actor: string
      id: string
    }): HydraEvent => ({
      ...event,
      type: 'card.replied',
      cardId: 'task-fixture',
      actor,
      data: {
        reply: id,
        state: 'delivered',
        route: 'pnyx',
        text: `Instruction from ${actor}.`,
      },
    })
    assert.deepEqual(
      read({
        card: 'task-fixture',
        entries: [],
        events: [
          reply({
            event: lookupEvents[0],
            actor: 'hydra',
            id: 'hydra',
          }),
          reply({
            event: lookupEvents[1],
            actor: 'worker:sample',
            id: 'worker',
          }),
        ],
      }).messages.map(message => ({
        id: message.id,
        role: message.role,
      })),
      [
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

test(
  'cursors, directions and inclusive ranges page without overlaps and keep their snapshot',
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

    const laterReply = {
      ...lookupEntries[8],
      id: '9:m0',
      reference: 'original:9:m0',
      text: 'A later reply.',
      at: '2026-01-01T00:00:08.500Z',
    }
    const later = {
      ...lookupEvents[8],
      seq: 10,
      id: 'event-10',
      at: '2026-01-01T00:00:09.000Z',
    }
    // A reply written after the newest event takes the next seq: a fresh read leaves it out
    // until an event follows it, and a cursor issued before it never returns it.
    const entries = [
      ...lookupEntries,
      laterReply,
    ]
    assert.equal(
      read({ entries }).messages.some(message => message.id === laterReply.reference),
      false,
    )
    assert.equal(
      read({
        entries,
        events: [
          ...lookupEvents,
          later,
        ],
        snapshot: 10,
      }).messages.some(message => message.id === laterReply.reference),
      true,
    )
    const continued = read({
      events: [
        ...lookupEvents,
        later,
      ],
      entries,
      snapshot: 10,
      selection: { cursor: newer.newer },
    })
    assert.deepEqual(
      [
        sequences({ page: continued }),
        continued.snapshot,
        continued.newer,
      ],
      [
        [
          8,
          9,
        ],
        9,
        undefined,
      ],
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

    const first = read({
      selection: {
        from: '3',
        to: '7',
        limit: 2,
      },
    })
    const next = read({
      selection: {
        cursor: first.newer,
        limit: 2,
      },
    })
    const last = read({
      selection: {
        from: '3',
        to: '7',
        direction: 'older',
        limit: 2,
      },
    })
    assert.deepEqual(
      [
        sequences({ page: first }),
        sequences({ page: next }),
        sequences({ page: read({ selection: { cursor: next.newer } }) }),
        sequences({ page: last }),
        sequences({ page: read({ selection: { cursor: last.older } }) }),
        sequences({
          page: read({
            selection: {
              from: '2026-01-01T00:00:01.500Z',
              to: '2026-01-01T00:00:05.500Z',
            },
          }),
        }),
      ],
      [
        [
          3,
          4,
        ],
        [
          5,
          6,
        ],
        [7],
        [
          6,
          7,
        ],
        [
          3,
          4,
          5,
        ],
        [
          3,
          4,
          5,
          6,
          7,
        ],
      ],
    )
  },
)

test(
  'invalid selections, cursors reused elsewhere and a message over the page budget fail explicitly',
  () => {
    const cursor = read({ selection: { seq: 5 } }).older

    const refusal = ({ ...options }: Parameters<typeof read>[0]) => {
      try {
        read(options)
      } catch (error) {
        return (error as { code?: string }).code
      }
    }

    assert.deepEqual(
      [
        refusal({ selection: { at: '01/01/2026' } }),
        refusal({ selection: { at: '2026-02-30T00:00:00Z' } }),
        refusal({ selection: { from: '2026-01-01T24:00:00Z' } }),
        refusal({
          selection: {
            from: '7',
            to: '3',
          },
        }),
        refusal({ selection: { seq: -1 } }),
        refusal({
          card: 'task-fixture',
          selection: { cursor },
        }),
        refusal({
          hydraId: 'another',
          selection: { cursor },
        }),
        refusal({
          entries: [
            {
              ...lookupEntries[0],
              text: 'x'.repeat(30000),
            },
          ],
        }),
      ],
      [
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'MESSAGE_TOO_LARGE',
      ],
    )
  },
)
