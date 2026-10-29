import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { hydraDir } from '#app/home-migration.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import { LOCK_TIMEOUT_MS } from '#store/storage.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

const PAST_LOCK_LIMIT_MS = LOCK_TIMEOUT_MS + 1000

for (const action of [
  'task-message',
  'move',
]) {
  test(
    `owner ${action} waits out a live writer lock and saves once while reads keep working`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Busy lock',
          '--key',
          'busy',
        ],
      })
      const card = s.task({ key: 'busy' })
      const page = await openPage({
        port: pnyx.port(),
        hydraId: s.hydraId,
      })
      const lock = join(
        hydraDir({ hydraId: s.hydraId }),
        'writer.lock',
      )
      const targetColumn = s.column({ role: 'in_progress' })
      assert.ok(targetColumn)
      const args = action === 'task-message'
        ? [
          card.id,
          'Hello while busy',
          'busy-owner-attempt',
        ]
        : [
          card.id,
          targetColumn,
          '--event-id',
          'busy-owner-attempt',
        ]
      const heldSince = Date.now()
      writeFileSync(
        lock,
        String(process.pid),
      )

      try {
        const sent = page.command({
          name: action,
          args,
        })
        // Observe rejection before waiting on the held lock.
        const outcome = (async () => {
          try {
            return { receipt: await sent }
          } catch (error) {
            return { error }
          }
        })()
        const reading = Date.now()
        await page.command({
          name: 'history',
          args: [
            '--limit',
            '1',
          ],
        })
        assert.ok(
          Date.now() - reading < LOCK_TIMEOUT_MS,
          'a read must finish during the lock hold',
        )
        await until({
          what: 'the pending lock response',
          check: () => page.checking.length > 0,
        })
        await until({
          what: 'the lock held beyond its ordinary wait limit',
          check: () => Date.now() - heldSince > PAST_LOCK_LIMIT_MS,
        })
        rmSync(lock)
        const result = await outcome
        assert.ok(
          'receipt' in result,
          JSON.stringify(result),
        )
        await page.command({
          name: action,
          args,
        })
        const saved = s.task({ key: 'busy' })

        if (action === 'task-message') {
          assert.equal(
            saved.replies?.filter(reply => reply.id === 'busy-owner-attempt').length,
            1,
          )
        } else {
          assert.equal(
            saved.column,
            s.column({ role: 'in_progress' }),
          )
          assert.equal(
            s.events().filter(event => event.id === 'busy-owner-attempt').length,
            1,
          )
        }

        assert.deepEqual(
          s.state(),
          replay({
            state: emptyHydra(),
            events: s.events(),
          }),
        )
      } finally {
        rmSync(
          lock,
          { force: true },
        )
        page.close()
      }
    },
  )
}
