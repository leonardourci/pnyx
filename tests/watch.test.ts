import { quietNativeWatch } from './setup/watch.ts'
import { watchPath } from '#app/watch.ts'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { until } from './setup/othrys.ts'

test(
  'a failed file notification is reconciled without another write',
  async () => {
    const path = join(
      process.env.TMPDIR!,
      'reconciled-file',
    )
    let failNext = false
    let observed: string | undefined
    writeFileSync(
      path,
      'before append',
    )
    const native = quietNativeWatch({ root: path })
    const watcher = watchPath({
      path,
      interval: 20,
      poll: true,
      changed: () => {
        if (failNext) {
          failNext = false
          throw new Error('writer temporarily unavailable')
        }

        observed = readFileSync(
          path,
          'utf8',
        )
      },
    })

    try {
      writeFileSync(
        path,
        'one append',
      )
      await until({
        what: 'the first write to be observed without a native notification',
        check: () => observed === 'one append',
      })
      observed = undefined
      failNext = true
      native.change({ path })
      await until({
        what: 'the unchanged file to be reconciled',
        check: () => observed === 'one append',
      })
    } finally {
      watcher.close()
    }
  },
)
