import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HydraEvent } from './model.ts'
import { history } from './cli.ts'
import { withWriter } from './writer.ts'
import { query } from '#store/postgres.ts'

const AT = '2026-10-13T10:00:00Z'
const NOTES = 60
const FILLER_PER_NOTE = 5

let seq = 0

const pushed = ({
  cardId,
  activity,
}: {
  cardId: string
  activity: string
}) => ({
  v: 1,
  seq: ++seq,
  id: `evt_${seq}`,
  at: AT,
  actor: 'cli',
  cardId,
  type: 'card.pushed',
  data: {
    key: `claude:host-a:${cardId}`,
    title: cardId,
    activity,
    source: {
      adapter: 'claude',
      objectId: cardId,
      instanceId: 'host-a',
      generation: 1,
      observedAt: AT,
    },
  },
}) as HydraEvent

const noted = ({ text }: { text: string }) => ({
  v: 1,
  seq: ++seq,
  id: `evt_${seq}`,
  at: AT,
  actor: 'cli',
  cardId: 'c1',
  type: 'card.noted',
  data: {
    kind: 'summary',
    source: 'hydra',
    text,
  },
}) as HydraEvent

const append = ({ events }: { events: HydraEvent[] }) => withWriter({
  hydraId: 'default',
  fn: ({ writer }) => events.forEach(event => writer.append({ event })),
})

type Page = {
  count?: string
  events: {
    id: string
    seq: number
    data: { text: string }
  }[] | string
  help?: string[]
}

const page = ({
  card = 'c1',
  updates = true,
  before,
}: {
  card?: string
  updates?: boolean
  before?: number
} = {}) => {
  const args = [
    '--card',
    card,
    '--full',
    '--limit',
    '50',
  ]

  if (updates) {
    args.push('--updates')
  }

  if (before !== undefined) {
    args.push(
      '--before',
      String(before),
    )
  }

  return history(args) as Page
}

const fresh = () => {
  seq = 0
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-history-',
  ))
}

test(
  'Activity lists new notes once, pages older notes, includes tagged messages and refuses unknown cards',
  () => {
    fresh()
    append({
      events: [
        pushed({
          cardId: 'c1',
          activity: 'working',
        }),
        ...Array.from(
          { length: NOTES },
          (
            _,
            note,
          ) => [
            noted({ text: `note ${note}` }),
            ...Array.from(
              { length: FILLER_PER_NOTE },
              (
                __,
                filler,
              ) => pushed({
                cardId: 'c2',
                activity: filler % 2 ? 'working' : 'idle',
              }),
            ),
          ],
        ).flat(),
      ],
    })
    assert.equal(
      page().count,
      '50, more before',
      'the first page lists the newest 50 of the card\'s notes',
    )

    const again = page()
    assert.deepEqual(
      Array.isArray(again.events) && again.events.slice(
        0,
        2,
      ).map(event => event.data.text),
      [
        'note 59',
        'note 58',
      ],
    )

    append({ events: [noted({ text: 'the newest note' })] })
    const latest = page()
    assert.equal(
      latest.count,
      '50, more before',
    )
    assert.equal(
      Array.isArray(latest.events) && latest.events[0]!.data.text,
      'the newest note',
    )

    const oldest = Array.isArray(latest.events) ? latest.events.at(-1)!.seq : 0
    const older = page({ before: oldest })
    assert.equal(
      older.count,
      '11',
    )
    assert.equal(
      older.help,
      undefined,
      'the last page names no older one',
    )

    append({
      events: [
        pushed({
          cardId: 'c1',
          activity: 'working',
        }),
        pushed({
          cardId: 'c2',
          activity: 'working',
        }),
        {
          v: 1,
          seq: ++seq,
          id: `evt_${seq}`,
          at: AT,
          actor: 'hydra',
          cardId: 'c2',
          type: 'hydra.message',
          data: {
            id: 'message-1',
            task: 'c1',
            action: 'send',
            hydra: 'hydra',
            text: '[@c1](pnyx-task:c1) is ready for review',
          },
        } as HydraEvent,
      ],
    })
    const tagged = page({ updates: false })
    assert.deepEqual(
      Array.isArray(tagged.events) && tagged.events.slice(
        0,
        2,
      ).map(event => event.id),
      [
        `evt_${seq}`,
        `evt_${seq - 2}`,
      ],
      'the message, named by its task and by a chip, is listed once',
    )
    assert.ok(Array.isArray(tagged.events))
    assert.equal(
      tagged.events.filter(event => event.id === `evt_${seq}`).length,
      1,
    )
    assert.equal(
      tagged.events.some(event => event.id === `evt_${seq - 1}`),
      false,
    )
    assert.throws(
      () => page({ card: 'nope' }),
      { code: 'NOT_FOUND' },
    )
  },
)

test(
  'the Updates rows the page reads through Zero list each card\'s events as history --updates does',
  () => {
    fresh()
    append({
      events: [
        pushed({
          cardId: 'c1',
          activity: 'working',
        }),
        pushed({
          cardId: 'c2',
          activity: 'working',
        }),
        noted({ text: 'Only the first task' }),
        {
          v: 1,
          seq: ++seq,
          id: `evt_${seq}`,
          at: AT,
          actor: 'worker:c1',
          cardId: '$hydra',
          type: 'hydra.message',
          // The first task's worker reporting to Hydra, which Updates shows, naming the second task with a chip.
          data: {
            id: 'message-both',
            task: 'c1',
            action: 'worker',
            hydra: 'hydra',
            text: 'Done, and [@c2](pnyx-task:c2) waits on this',
          },
        } as HydraEvent,
      ],
    })

    for (const card of [
      'c1',
      'c2',
    ]) {
      const listed = page({ card }).events
      assert.ok(Array.isArray(listed))
      const [rows] = query({
        statements: [
          {
            text: 'select seq from card_updates where hydra_id = \'default\' and card_id = $1 order by seq desc',
            values: [card],
          },
        ],
      }) as { seq: string }[][]
      assert.deepEqual(
        rows!.map(row => Number(row.seq)),
        listed.map(event => event.seq),
        card,
      )
    }

    const [shared] = query({
      statements: [{ text: `select card_id from card_updates where hydra_id = 'default' and seq = ${seq} order by card_id` }],
    }) as { card_id: string }[][]
    assert.deepEqual(
      shared!.map(row => row.card_id),
      [
        '$hydra',
        'c1',
        'c2',
      ],
      'a message is listed by its own card, its task and the task it mentions',
    )
  },
)
