import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactReceipt } from './receipt.ts'

test(
  'legacy full receipts omit unchanged accumulated history without losing identity or changed fields',
  () => {
    const history = Array.from(
      { length: 100 },
      (
        _,
        index,
      ) => ({
        id: `old-${index}`,
        text: 'x'.repeat(12000),
      }),
    )
    const before = {
      id: 'synthetic',
      revision: 2,
      brief: 'old',
      notes: history,
    }
    const after = {
      ...before,
      revision: 3,
      brief: 'new',
    }
    const output = compactReceipt({
      output: {
        id: 'original-transaction',
        duplicate: true,
        revisions: { synthetic: 3 },
        diff: [
          {
            task: 'synthetic',
            before,
            after,
          },
        ],
      },
    })
    assert.ok(JSON.stringify(output).length < 1000)
    assert.equal(
      output.id,
      'original-transaction',
    )
    assert.equal(
      output.duplicate,
      true,
    )
    assert.deepEqual(
      output.diff,
      [
        {
          task: 'synthetic',
          fields: [
            'revision',
            'brief',
          ],
          before: {
            revision: 2,
            brief: 'old',
          },
          after: {
            revision: 3,
            brief: 'new',
          },
        },
      ],
    )
  },
)
