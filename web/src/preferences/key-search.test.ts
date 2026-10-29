import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupOf, keyActionsMatching } from './key-search.ts'

const labels = ({ query }: { query: string }) => keyActionsMatching({ query })
  .map(action => action.label)

test(
  'a search finds key actions by every word of their name, group or default keys, and groups them by where they work',
  () => {
    assert.deepEqual(
      labels({ query: 'next card' }),
      ['Next card'],
    )
    assert.ok(labels({ query: 'board' }).includes('Previous card'))
    assert.ok(labels({ query: 'mod+k' }).includes('Focus Oracle'))
    assert.deepEqual(
      labels({ query: 'nothing like this' }),
      [],
    )
    assert.equal(
      labels({ query: '' }).length,
      keyActionsMatching({ query: '   ' }).length,
    )

    const [focusOracle] = keyActionsMatching({ query: 'focus oracle' })
    assert.equal(
      groupOf({ action: focusOracle! }),
      'Everywhere',
    )
  },
)
