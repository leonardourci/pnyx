import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorDetails } from './error-details.ts'
import { HydraError } from './errors.ts'

test(
  'an empty AggregateError retains connection codes and inner failures across worker serialization',
  () => {
    const refused = Object.assign(
      new Error('connect ECONNREFUSED ::1:5432'),
      { code: 'ECONNREFUSED' },
    )
    const missing = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      { code: 'ECONNREFUSED' },
    )
    const aggregate = Object.assign(
      new AggregateError(
        [
          refused,
          missing,
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    )
    const details = structuredClone(errorDetails({ error: aggregate }))
    assert.match(
      details.message,
      /ECONNREFUSED.*::1:5432.*127.0.0.1:5432/,
    )
    assert.equal(
      details.code,
      'ECONNREFUSED',
    )
    assert.deepEqual(
      details.errors?.map(error => error.code),
      [
        'ECONNREFUSED',
        'ECONNREFUSED',
      ],
    )
    const wrapped = new HydraError({
      message: `Postgres: ${details.message}`,
      code: 'DATABASE_UNAVAILABLE',
      cause: details,
    })
    assert.equal(
      errorDetails({ error: wrapped }).cause?.errors?.length,
      2,
    )
  },
)

test(
  'nested and circular causes remain printable',
  () => {
    const inner = new Error('disk unavailable')
    const outer = new Error(
      '',
      { cause: inner },
    )
    inner.cause = outer
    assert.match(
      errorDetails({ error: outer }).message,
      /disk unavailable/,
    )
    assert.equal(
      errorDetails({ error: outer }).cause?.cause?.message,
      '[circular error]',
    )
  },
)
