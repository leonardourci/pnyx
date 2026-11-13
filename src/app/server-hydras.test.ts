import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from './cli.ts'
import { createHydra, listHydras } from './server-hydras.ts'

test(
  'a Hydra reports the creation attempt of its first event only',
  async t => {
    const previous = process.env.PNYX_HOME
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-hydras-',
    ))
    process.env.PNYX_HOME = root
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const created = createHydra({
      name: 'Lab',
      attempt: 'first',
    })
    assert.equal(
      createHydra({
        name: 'Lab',
        attempt: 'first',
      }),
      created,
    )
    await commands.task([
      'create',
      '--key',
      'work',
      '--title',
      'Work',
      '--event-id',
      'hydra-create:later',
      '--hydra',
      created,
    ])
    const plain = createHydra({ name: 'Plain' })
    const attempts = Object.fromEntries(listHydras().map(hydra => [
      hydra.id,
      hydra.creationAttempt,
    ]))
    assert.equal(
      attempts[created],
      'first',
    )
    assert.equal(
      attempts[plain],
      undefined,
    )
  },
)
