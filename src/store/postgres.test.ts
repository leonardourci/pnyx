import assert from 'node:assert/strict'
import test from 'node:test'
import { query } from './postgres.ts'

test(
  'a home gets its own migrated database, and a failed transaction leaves nothing behind',
  () => {
    const [tables] = query({ statements: [{ text: 'select count(*)::int as count from information_schema.tables where table_name = \'hydras\'' }] })
    assert.deepEqual(
      tables,
      [{ count: 1 }],
    )

    assert.throws(
      () => query({
        transaction: true,
        statements: [
          {
            text: 'insert into hydras (id, summary, queue) values ($1, \'{}\', \'{}\')',
            values: ['kept-out'],
          },
          {
            text: 'insert into hydras (id, summary, queue) values ($1, \'{}\', \'{}\')',
            values: ['kept-out'],
          },
        ],
      }),
      { code: 'CONFLICT' },
    )
    const [rows] = query({ statements: [{ text: 'select id from hydras' }] })
    assert.deepEqual(
      rows,
      [],
    )
  },
)
