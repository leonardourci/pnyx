import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHydra } from '../src/server/hydras.ts'
import { hydraDir } from '../src/app/home-migration.ts'
import { readEvents } from '../src/app/event-log.ts'

test(
  'a creation attempt recovers the same sequential identity from the configuration event',
  () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-create-attempt-',
    ))
    process.env.PNYX_HOME = home

    try {
      const first = createHydra({
        name: 'Research',
        attempt: 'first-attempt',
      })
      const second = createHydra({
        name: 'Second',
        attempt: 'second-attempt',
      })
      appendFileSync(
        join(
          hydraDir({ hydraId: second }),
          'events.jsonl',
        ),
        'corrupt later event\n',
      )
      const recovered = createHydra({
        name: 'Changed after timeout',
        attempt: 'first-attempt',
      })
      assert.equal(
        first,
        'hydra-1',
      )
      assert.equal(
        second,
        'hydra-2',
      )
      assert.equal(
        recovered,
        first,
      )
      const events = readEvents({ hydraId: first })
      assert.equal(
        events.length,
        1,
      )
      assert.equal(
        events[0]?.id,
        'hydra-create:first-attempt',
      )
      assert.equal(
        events[0]?.type,
        'board.configured',
      )
      assert.equal(
        events[0]?.data.name,
        'Research',
      )
      appendFileSync(
        join(
          hydraDir({ hydraId: first }),
          'events.jsonl',
        ),
        'corrupt later event\n',
      )
      assert.equal(
        createHydra({
          name: 'Retry corrupt matching Hydra',
          attempt: 'first-attempt',
        }),
        first,
      )
      assert.equal(
        createHydra({
          name: 'Independent creation',
          attempt: 'third-attempt',
        }),
        'hydra-3',
      )
    } finally {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
