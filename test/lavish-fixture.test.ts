import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { lavishFixture } from './scenarios/lavish-fixture.ts'

test(
  'a Lavish listener cannot consume a delivery before its payload is complete',
  t => {
    const folder = fs.mkdtempSync(join(
      tmpdir(),
      'pnyx-lavish-publication-',
    ))
    const fixture = lavishFixture({ folder })
    const delivery = join(
      folder,
      'deliver.toon',
    )
    const body = 'session:\n  status: feedback\n'
    const write = fs.writeFileSync
    let consumed: string | undefined
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(
        folder,
        {
          recursive: true,
          force: true,
        },
      )
    })
    t.mock.method(
      fs,
      'writeFileSync',
      // Preserve the filesystem API's positional arguments.
      // eslint-disable-next-line pnyx/object-params
      (...args: Parameters<typeof write>) => {
        if (args[1] === body) {
          write(
            args[0],
            '',
          )

          if (fs.existsSync(delivery)) {
            consumed = fs.readFileSync(
              delivery,
              'utf8',
            )
            fs.unlinkSync(delivery)
          }
        }

        return write(...args)
      },
    )
    syncBuiltinESMExports()
    fixture.deliver({ body })
    assert.equal(
      consumed,
      undefined,
      'the listener must wait for the completed delivery',
    )
    assert.equal(
      fs.readFileSync(
        delivery,
        'utf8',
      ),
      body,
    )
  },
)
