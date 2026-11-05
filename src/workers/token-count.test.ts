import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countTokens } from './token-count.ts'

test(
  'token counts prefer a valid report and otherwise estimate UTF-8 bytes',
  () => {
    assert.deepEqual(
      countTokens({
        text: '',
        reported: 0,
      }),
      {
        tokens: 0,
        source: 'reported',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'abc',
        reported: 42,
      }),
      {
        tokens: 42,
        source: 'reported',
      },
    )
    assert.deepEqual(
      countTokens({ text: '' }),
      {
        tokens: 0,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({ text: 'abcde' }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({ text: '😀😀' }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'é',
        reported: -1,
      }),
      {
        tokens: 1,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'é',
        reported: 1.5,
      }),
      {
        tokens: 1,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'é',
        reported: Infinity,
      }),
      {
        tokens: 1,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'é',
        reported: NaN,
      }),
      {
        tokens: 1,
        source: 'estimated',
      },
    )
  },
)
