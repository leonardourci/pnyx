import assert from 'node:assert/strict'
import { query } from '#store/postgres.ts'
import { watchFile, unwatchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

const LISTENERS = 11

test(
  'SQL timeouts remain in the diagnostic log after the launcher exits',
  () => {
    assert.throws(
      () => query({
        statements: [
          { text: 'set statement_timeout = 1' },
          { text: 'select pg_sleep(1) as launcher_sql_timeout' },
        ],
      }),
      { code: 'DATABASE_UNAVAILABLE' },
    )
  },
)

test(
  'a listener leak makes the launched suite fail',
  async t => {
    const path = join(
      process.env.PNYX_HOME!,
      'watched',
    )
    writeFileSync(
      path,
      '',
    )
    t.after(() => unwatchFile(path))

    for (let index = 0; index < LISTENERS; index++) {
      watchFile(
        path,
        { persistent: false },
        () => {},
      )
    }

    await setImmediate()
  },
)
