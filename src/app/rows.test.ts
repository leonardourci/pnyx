import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePush } from '#tasks/push.ts'
import { emptyHydra, replayOwned } from './reducer.ts'
import { emptySaved, rowChanges } from './rows.ts'

const stateWithCard = ({ brief }: { brief: string }) => {
  const state = emptyHydra()
  const decision = decidePush({
    state,
    key: 'ship',
    input: { title: 'Ship it' },
    newCardId: 'ship',
    meta: {
      actor: 'test',
      id: 'created',
      at: '2026-11-13T12:00:00.000Z',
    },
  })
  replayOwned({
    state,
    events: 'event' in decision ? [decision.event] : [],
  })
  state.cards.ship!.brief = brief

  return state
}

test(
  'the saved rows keep a short digest of each row, so a large row is not held twice, and an unchanged row writes nothing',
  () => {
    const state = stateWithCard({ brief: 'long brief '.repeat(50_000) })
    const first = rowChanges({
      hydraId: 'lab',
      state,
      saved: emptySaved(),
    })

    assert.ok(first.statements.length > 0)

    for (const entry of first.next.values()) {
      assert.ok(entry.digest.length <= 32)
      assert.equal(
        'json' in entry,
        false,
      )
    }

    assert.deepEqual(
      rowChanges({
        hydraId: 'lab',
        state,
        saved: first.next,
      }).statements,
      [],
    )

    state.cards.ship!.brief = 'a shorter brief'
    assert.ok(rowChanges({
      hydraId: 'lab',
      state,
      saved: first.next,
    }).statements.length > 0)
  },
)
