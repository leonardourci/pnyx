import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tokens } from './query.ts'

test(
  'search words split at punctuation the same way in every search box',
  () => {
    assert.deepEqual(
      tokens({ text: 'Deploy/rollback: CI-CD' }),
      [
        'deploy',
        'rollback',
        'ci',
        'cd',
      ],
    )
  },
)
