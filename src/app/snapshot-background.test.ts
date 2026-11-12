import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { holdHydra, heldHydra, loadHydra } from './store.ts'
import { withWriter, saveSnapshot } from './writer.ts'
import { readSnapshot } from './snapshot.ts'
import { settle } from '#test-harness/child-fixture.ts'

test(
  'dirty snapshots save on the timer and flush the final log at shutdown, recovering from a failed cache write',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-background-snapshot-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const release = holdHydra({
      hydraId: 'default',
      changed() {},
    })
    const live = heldHydra({ hydraId: 'default' })!
    t.after(async () => {
      t.mock.timers.reset()

      try {
        await saveSnapshot({ live })
      } finally {
        release()

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
    })
    mkdirSync(
      live.dir,
      { recursive: true },
    )
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const append = ({ id }: { id: string }) => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id,
          cardId: id,
          type: 'task.created',
          actor: 'test',
          at: '2026-11-12T00:00:00Z',
          data: {
            key: id,
            title: id,
          },
        },
      }),
    })
    append({ id: 'first' })
    t.mock.timers.tick(59_999)
    assert.equal(
      readSnapshot({ dir: live.dir }),
      null,
    )
    append({ id: 'second' })
    t.mock.timers.tick(1)
    await settle({
      what: 'the timed snapshot',
      check: () => readSnapshot({ dir: live.dir }),
    })
    assert.ok(readSnapshot({ dir: live.dir })?.state.cards.second)
    append({ id: 'final' })
    await Promise.all([
      saveSnapshot({ live }),
      saveSnapshot({ live }),
    ])
    assert.deepEqual(
      readSnapshot({ dir: live.dir })?.state,
      live.state,
    )
    rmSync(join(
      live.dir,
      'snapshot.json',
    ))
    mkdirSync(join(
      live.dir,
      'snapshot.json',
    ))
    await assert.rejects(saveSnapshot({ live }))
    assert.ok(loadHydra({ hydraId: 'default' }).state.cards.final)
    rmSync(
      join(
        live.dir,
        'snapshot.json',
      ),
      { recursive: true },
    )
    await saveSnapshot({ live })
    release()
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      live.state,
    )
  },
)
