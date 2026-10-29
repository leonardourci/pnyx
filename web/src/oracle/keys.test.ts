import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inputKey } from './keys.ts'

const press = ({
  key,
  composing = false,
  pending = false,
  first,
}: {
  key: string
  composing?: boolean
  pending?: boolean
  first?: string
}) => inputKey({
  key,
  composing,
  pending,
  first,
})

test(
  'Enter opens the top task once the query is answered, and waits while it is not',
  () => {
    assert.equal(
      press({
        key: 'Enter',
        first: 'hit:task-1',
      }),
      'open',
    )
    assert.equal(
      press({
        key: 'Enter',
        pending: true,
        first: 'theme',
      }),
      'wait',
      'a settings row shown before the answer arrives is not what Enter means',
    )
    assert.equal(
      press({
        key: 'Enter',
        first: 'theme',
      }),
      'first',
    )
  },
)

test(
  'arrows pressed before the answer wait for it, so they never land on rows about to move',
  () => {
    for (const key of [
      'ArrowDown',
      'ArrowUp',
    ]) {
      assert.equal(
        press({
          key,
          pending: true,
          first: 'theme',
        }),
        'wait',
      )
    }
  },
)

test(
  'no key acts while an IME is composing',
  () => {
    for (const key of [
      'Enter',
      'Escape',
      'ArrowDown',
    ]) {
      assert.equal(
        press({
          key,
          composing: true,
          first: 'hit:task-1',
        }),
        null,
      )
    }
  },
)

test(
  'arrows move to the ends of the results, Escape clears, typing stays in the input',
  () => {
    assert.equal(
      press({ key: 'ArrowDown' }),
      'first',
    )
    assert.equal(
      press({ key: 'ArrowUp' }),
      'last',
    )
    assert.equal(
      press({ key: 'Escape' }),
      'clear',
    )
    assert.equal(
      press({ key: 'd' }),
      null,
    )
  },
)
