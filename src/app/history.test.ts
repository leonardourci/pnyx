import assert from 'node:assert/strict'
import fs, { mkdtempSync, statSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HydraEvent } from './model.ts'
import { history } from './cli.ts'
import { hydraDir } from './home-migration.ts'
import { withWriter } from './writer.ts'
import { logPath } from '#store/storage.ts'

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

const logSize = () => statSync(logPath({ dir: hydraDir({ hydraId: 'default' }) })).size

test(
  'an Activity page reads only the bytes appended since the last page, not the snapshot or the whole log',
  t => {
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
      '50 of 60 total',
      'the first page lists the newest 50 of the card\'s notes',
    )

    let read = 0
    const {
      readSync,
      readFileSync,
    } = fs
    t.mock.method(
      fs,
      'readSync',
      // eslint-disable-next-line pnyx/object-params -- preserves the fs API signature
      (...args: Parameters<typeof readSync>) => {
        const bytes = readSync(...args)
        read += bytes

        return bytes
      },
    )
    t.mock.method(
      fs,
      'readFileSync',
      // eslint-disable-next-line pnyx/object-params -- preserves the fs API signature
      (...args: Parameters<typeof readFileSync>) => {
        const content = readFileSync(...args)
        read += typeof content === 'string' ? Buffer.byteLength(content) : content.length

        return content
      },
    )
    syncBuiltinESMExports()

    try {
      const size = logSize()
      const again = page()
      assert.ok(
        read < size / 20,
        `an unchanged log reads neither the snapshot nor the log (read ${read} of ${size} bytes)`,
      )
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
      read = 0
      const latest = page()
      assert.ok(
        read < size / 20,
        `a grown log reads only its new line (read ${read} of ${logSize()} bytes)`,
      )
      assert.equal(
        latest.count,
        '50 of 61 total',
      )
      assert.equal(
        Array.isArray(latest.events) && latest.events[0]!.data.text,
        'the newest note',
      )

      const oldest = Array.isArray(latest.events) ? latest.events.at(-1)!.seq : 0
      const older = page({ before: oldest })
      assert.equal(
        older.count,
        `11 of 11 before ${oldest}`,
      )
      assert.equal(
        older.help,
        undefined,
        'the last page names no older one',
      )
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  },
)

test(
  'a card\'s history lists a Hydra message that names it once, and an unknown card is refused',
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
      Array.isArray(tagged.events) && tagged.events.map(event => event.id),
      [
        `evt_${seq}`,
        `evt_${seq - 2}`,
      ],
      'the message, named by its task and by a chip, is listed once',
    )
    assert.throws(
      () => page({ card: 'nope' }),
      { code: 'NOT_FOUND' },
    )
  },
)
