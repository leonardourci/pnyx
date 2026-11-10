import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAGE_LINES_MAX } from '#app/log-line.ts'
import { MAX_MESSAGE_BYTES } from '#app/server-protocol.ts'
import { batchSize } from './log.ts'

test(
  'page log batches stay within the server’s message limit and line count, even when every character takes three bytes in UTF-8',
  () => {
    const lines = Array.from(
      { length: 250 },
      (
        _,
        index,
      ) => JSON.stringify({
        operation: 'page.update',
        name: '日'.repeat(400),
        index,
      }),
    )
    const batches: string[][] = []
    let rest = lines

    while (rest.length) {
      const count = batchSize({ lines: rest })
      batches.push(rest.slice(
        0,
        count,
      ))
      rest = rest.slice(count)
    }

    assert.equal(
      batches.flat().length,
      250,
    )
    assert.ok(batches.every(batch => batch.length <= PAGE_LINES_MAX))
    assert.ok(batches.every(batch => Buffer.byteLength(`{"type":"log","lines":[${batch.join(',')}]}`) <= MAX_MESSAGE_BYTES))
  },
)
