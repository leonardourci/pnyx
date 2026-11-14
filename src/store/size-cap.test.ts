import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capItem } from './size-cap.ts'

test(
  'an item that fits is returned as it is',
  () => {
    const item = {
      text: 'short',
      list: [1],
    }

    assert.equal(
      capItem({ value: item }),
      item,
    )
  },
)

test(
  'an item over the limit keeps its shape with its long strings cut',
  () => {
    const item = {
      id: 'e1',
      data: {
        text: 'long '.repeat(40_000),
        nested: [{ output: 'x'.repeat(100_000) }],
      },
    }
    const capped = capItem({ value: item })

    assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 64 * 1024)
    assert.equal(
      capped.id,
      'e1',
    )
    assert.match(
      capped.data.text,
      /more characters cut\)$/,
    )
    assert.ok(Array.isArray(capped.data.nested))
  },
)
