import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countTokens } from './token-count.ts'

test(
  'token estimates use UTF-8 bytes and valid reported counts win',
  () => {
    assert.deepEqual(
      countTokens({ text: '' }),
      {
        tokens: 0,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({ text: 'hello' }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({ text: '你好🙂' }),
      {
        tokens: 3,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'hello',
        reported: 0,
      }),
      {
        tokens: 0,
        source: 'reported',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'hello',
        reported: 8,
      }),
      {
        tokens: 8,
        source: 'reported',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'hello',
        reported: -1,
      }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'hello',
        reported: 1.5,
      }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'hello',
        reported: NaN,
      }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
    assert.deepEqual(
      countTokens({
        text: 'hello',
        reported: Infinity,
      }),
      {
        tokens: 2,
        source: 'estimated',
      },
    )
  },
)
