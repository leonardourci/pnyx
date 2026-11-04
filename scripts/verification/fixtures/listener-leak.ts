import { watchFile, unwatchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

const LISTENERS = 11

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
