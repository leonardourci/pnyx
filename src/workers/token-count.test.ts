import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countTokens } from './token-count.ts'

test(
  'token counts estimate UTF-8 bytes, including empty and multibyte text',
  () => {
    assert.equal(
      countTokens({ text: '' }),
      0,
    )
    assert.equal(
      countTokens({ text: 'abcd' }),
      1,
    )
    assert.equal(
      countTokens({ text: 'abcde' }),
      2,
    )
    assert.equal(
      countTokens({ text: '😀😀' }),
      2,
    )
    assert.equal(
      countTokens({ text: 'é' }),
      1,
    )
  },
)
