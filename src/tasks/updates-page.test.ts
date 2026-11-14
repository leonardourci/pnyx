import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyDecision } from '#app/decision.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from './push.ts'
import { taskUpdates } from './updates-page.ts'

const titled = ({ number }: { number: number }) => ({ title: `Release ${number}` })

// The last push also carries text far over the 64 KB an item may weigh.
const heavy = ({ number }: { number: number }) => ({
  title: `Release ${number}`,
  activity: 'x'.repeat(200_000),
})

test(
  'a card\'s updates read newest first, a page at a time, from the saved events',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-task-updates-',
    ))
    withWriter({
      hydraId: 'lab',
      create: true,
      fn: ({ writer }) => {
        for (let number = 1; number <= 7; number++) {
          applyDecision({
            writer,
            decision: decidePush({
              state: writer.state,
              key: 'ship',
              input: number === 7 ? heavy({ number }) : titled({ number }),
              newCardId: number === 1 ? 'ship' : undefined,
              meta: {
                actor: 'test',
                id: `ship-${number}`,
                at: `2026-11-13T12:00:0${number}.000Z`,
              },
            }),
          })
        }
      },
    })
    const first = taskUpdates({
      hydraId: 'lab',
      ref: 'ship',
      limit: 3,
    })
    const second = taskUpdates({
      hydraId: 'lab',
      ref: 'ship',
      limit: 3,
      before: first.older,
    })
    const seqs = [
      ...first.events,
      ...second.events,
    ].map(event => event.seq)

    assert.equal(
      first.events.length,
      3,
    )
    assert.equal(
      first.older,
      first.events.at(-1)!.seq,
    )
    assert.deepEqual(
      seqs,
      seqs.toSorted((
        a,
        b,
      ) => b - a),
      'newest first across pages',
    )
    assert.equal(
      new Set(seqs).size,
      seqs.length,
      'no event on two pages',
    )

    let all = taskUpdates({
      hydraId: 'lab',
      ref: 'ship',
      limit: 200,
    })

    assert.equal(
      all.older,
      undefined,
      'the last page has no older cursor',
    )
    assert.equal(
      all.events.length,
      6,
      'six pushes that rename the card',
    )
    assert.equal(
      second.events.length,
      3,
    )
    assert.equal(
      second.older,
      undefined,
    )
    assert.ok(
      Buffer.byteLength(JSON.stringify(all.events[0])) < 70_000,
      'one huge event does not make a page heavy',
    )
    all = taskUpdates({
      hydraId: 'lab',
      ref: 'ship',
      before: all.events.at(-1)!.seq,
    })
    assert.deepEqual(
      all.events,
      [],
    )
  },
)

test(
  'a read of a card\'s updates refuses a page size or cursor it cannot serve',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-task-updates-',
    ))
    withWriter({
      hydraId: 'lab',
      create: true,
      fn: () => {},
    })

    assert.throws(
      () => taskUpdates({
        hydraId: 'lab',
        ref: 'ship',
        limit: 0,
      }),
      /limit must be/,
    )
    assert.throws(
      () => taskUpdates({
        hydraId: 'lab',
        ref: 'ship',
        before: 0,
      }),
      /before must be/,
    )
  },
)
