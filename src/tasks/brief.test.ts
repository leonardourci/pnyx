import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HydraError } from '#store/errors.ts'
import { taskBrief } from './cli.ts'
import { MAX_BRIEF_LENGTH } from './model.ts'

test(
  'a brief holds up to the shared limit the brief editor also checks',
  () => {
    const longest = 'x'.repeat(MAX_BRIEF_LENGTH)
    assert.equal(
      taskBrief({ value: longest }),
      longest,
    )
    assert.throws(
      () => taskBrief({ value: `${longest}x` }),
      (error: unknown) => error instanceof HydraError && error.code === 'VALIDATION_ERROR',
    )
  },
)
