import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draft } from './draft.ts'

test(
  'changes to nested arrays and deleted fields retain unrelated branches',
  () => {
    const state = {
      cards: {
        a: {
          values: [
            1,
            2,
          ],
          note: 'old',
        },
        b: {
          values: [3],
          note: 'kept',
        },
      },
    }
    const before = structuredClone(state)
    const next = draft({
      state,
      change: ({ state }) => {
        state.cards.a.values.push(4)
        delete (state.cards.a as { note?: string }).note
      },
    })
    assert.deepEqual(
      state,
      before,
    )
    assert.deepEqual(
      next.cards.a,
      {
        values: [
          1,
          2,
          4,
        ],
      },
    )
    assert.equal(
      next.cards.b,
      state.cards.b,
    )
  },
)

test(
  'reading, setting equal values and deleting absent fields copy nothing',
  () => {
    const state = { value: { count: 1 } }
    const next = draft({
      state,
      change: ({ state }) => {
        state.value.count = 1
        delete (state.value as { absent?: string }).absent
      },
    })
    assert.equal(
      next,
      state,
    )
  },
)

test(
  'new objects remain writable through the reducer local and through the state',
  () => {
    const state: { rows: { count: number }[] } = { rows: [] }
    const next = draft({
      state,
      change: ({ state }) => {
        const row = { count: 0 }
        state.rows.push(row)
        state.rows[0]!.count++
        row.count++
      },
    })
    assert.deepEqual(
      next.rows,
      [{ count: 2 }],
    )
    assert.deepEqual(
      state.rows,
      [],
    )
  },
)
