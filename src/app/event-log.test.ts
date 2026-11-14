import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { query } from '#store/postgres.ts'
import { taskMention } from '#hydra/mentions.ts'
import type { HydraEvent } from './model.ts'
import { readEvents, scanEvents } from './event-log.ts'

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-event-selection-',
  ))
})

function seed(): HydraEvent[] {
  const events: HydraEvent[] = Array.from(
    { length: 450 },
    (
      _,
      index,
    ) => ({
      v: 1,
      seq: index + 1,
      id: `note-${index}`,
      type: 'card.noted',
      actor: 'test',
      at: '2026-11-13T12:00:00.000Z',
      cardId: index % 2 ? 'one' : 'two',
      data: {
        text: `Note ${index}`,
        kind: 'context',
        source: 'test',
      },
    }),
  )
  const tagged = 'task/with:characters'
  events.push({
    v: 1,
    seq: 451,
    id: 'tagged',
    type: 'hydra.message',
    actor: 'owner',
    at: '2026-11-13T12:00:00.000Z',
    cardId: '$hydra',
    data: {
      hydra: 'lab',
      action: 'send',
      text: taskMention({
        id: tagged,
        title: 'Tagged task',
      }),
    },
  } as HydraEvent)
  events.push({
    v: 1,
    seq: 452,
    id: 'assignment',
    type: 'task.session',
    actor: 'test',
    at: '2026-11-13T12:00:00.000Z',
    cardId: 'origin',
    data: {
      session: 'claude-code:fixture',
      before: 'one',
      after: 'two',
    },
  })
  query({
    transaction: true,
    statements: [
      { text: 'insert into hydras (id, seq, summary) values (\'lab\', 452, \'{}\')' },
      {
        text: 'insert into events select * from json_populate_recordset(null::events, $1::json)',
        values: [
          JSON.stringify(events.map(event => ({
            hydra_id: 'lab',
            seq: event.seq,
            id: event.id,
            type: event.type,
            at: event.at,
            actor: event.actor,
            card_id: event.cardId,
            data: event,
          }))),
        ],
      },
    ],
  })

  return events
}

test(
  'event selectors apply card, type, ID, sequence, boundary and limit filters before returning history',
  () => {
    const events = seed()
    const expected = events.filter(event => event.cardId === 'one' && event.type === 'card.noted' && event.seq > 10 && event.seq < 430).reverse()
      .slice(
        0,
        3,
      )
    assert.deepEqual(
      readEvents({
        hydraId: 'lab',
        cardId: 'one',
        types: ['card.noted'],
        after: 10,
        before: 430,
        limit: 3,
        descending: true,
      }),
      expected,
    )
    assert.deepEqual(
      readEvents({
        hydraId: 'lab',
        ids: ['note-12'],
      }),
      [events[12]],
    )
    assert.deepEqual(
      readEvents({
        hydraId: 'lab',
        seqs: [
          2,
          8,
        ],
      }),
      [
        events[1],
        events[7],
      ],
    )
    assert.deepEqual(
      readEvents({
        hydraId: 'lab',
        cardId: 'task/with:characters',
      }).map(event => event.id),
      ['tagged'],
    )
    assert.equal(
      readEvents({
        hydraId: 'lab',
        cardId: 'one',
        types: ['task.session'],
      })[0]?.id,
      'assignment',
    )
    assert.equal(
      readEvents({
        hydraId: 'lab',
        cardId: 'unrelated',
        types: ['task.session'],
      }).length,
      0,
    )
  },
)

test(
  'bounded scans traverse more than two pages in both directions without losing or repeating events',
  () => {
    const events = seed()
    assert.deepEqual(
      [...scanEvents({ hydraId: 'lab' })],
      events,
    )
    assert.deepEqual(
      [
        ...scanEvents({
          hydraId: 'lab',
          descending: true,
        }),
      ],
      events.toReversed(),
    )
  },
)
