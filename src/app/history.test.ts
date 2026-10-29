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

const page = ({ before }: { before?: number } = {}) => history([
  '--card',
  'c1',
  '--updates',
  '--full',
  '--limit',
  '50',
  ...before === undefined ? [] : [
    '--before',
    String(before),
  ],
]) as {
  count?: string
  events: {
    seq: number
    data: { text: string }
  }[] | string
  help?: string[]
}

const logSize = () => statSync(logPath({ dir: hydraDir({ hydraId: 'default' }) })).size

test(
  'an Activity page reads only the bytes appended since the last page, not the snapshot or the whole log',
  t => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-history-',
    ))
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
      `50 of ${NOTES} total`,
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
      const again = page()
      assert.equal(
        read,
        0,
        'an unchanged log reads nothing',
      )
      assert.deepEqual(
        Array.isArray(again.events) && again.events.slice(
          0,
          2,
        ).map(event => event.data.text),
        [
          `note ${NOTES - 1}`,
          `note ${NOTES - 2}`,
        ],
      )

      const size = logSize()
      append({ events: [noted({ text: 'the newest note' })] })
      const grown = logSize() - size
      read = 0
      const latest = page()
      assert.equal(
        read,
        grown,
        'a grown log reads only its new line',
      )
      assert.equal(
        latest.count,
        `50 of ${NOTES + 1} total`,
      )
      assert.equal(
        Array.isArray(latest.events) && latest.events[0]!.data.text,
        'the newest note',
      )

      const oldest = Array.isArray(latest.events) ? latest.events.at(-1)!.seq : 0
      const older = page({ before: oldest })
      assert.equal(
        older.count,
        `${NOTES + 1 - 50} of ${NOTES + 1 - 50} before ${oldest}`,
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
