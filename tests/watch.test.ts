import { watchPath } from '#app/watch.ts'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { until } from './setup/pnyx.ts'

test(
  'a failed file notification is reconciled without another write',
  async () => {
    const path = join(
      process.env.TMPDIR!,
      'reconciled-file',
    )
    let attempts = 0
    let observed: string | undefined
    const watcher = watchPath({
      path,
      interval: 20,
      poll: true,
      changed: () => {
        attempts++

        if (attempts === 1) {
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
        what: 'the unchanged file to be reconciled',
        check: () => observed === 'one append',
      })
    } finally {
      watcher.close()
    }
  },
)
