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
  'an unchanged row writes nothing and a changed brief is saved',
  () => {
    const state = stateWithCard({ brief: 'long brief '.repeat(50_000) })
    const first = rowChanges({
      hydraId: 'lab',
      state,
      saved: emptySaved(),
    })

    assert.ok(first.statements.length > 0)

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
