import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { copiesDir, freshSlot, unclaim } from '#projects/copy-pool.ts'

const queue = vi.hoisted(() => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}))

vi.mock(
  '#app/writer.ts',
  () => ({
    withWriter: async ({ fn }: { fn(): unknown }) => {
      queue.entered.resolve()
      await queue.release.promise

      return fn()
    },
  }),
)

test(
  'fresh copy reservations skip occupied slots and slots held by a concurrent start',
  async () => {
    const hydraId = 'queued-copy'
    const dir = copiesDir()
    mkdirSync(
      dir,
      { recursive: true },
    )
    const occupied = join(
      dir,
      'project-1',
    )
    const next = join(
      dir,
      'project-2',
    )
    const third = join(
      dir,
      'project-3',
    )
    const decision = freshSlot({
      hydraId,
      project: {
        name: 'project',
        path: dir,
        detached: false,
      },
    })

    try {
      const phase = await Promise.race([
        queue.entered.promise.then(() => 'waiting'),
        decision,
      ])
      expect(phase).toBe('waiting')
      mkdirSync(occupied)
      const marker = join(
        occupied,
        'owner-work',
      )
      writeFileSync(
        marker,
        'Work saved by the competing start',
      )
      queue.release.resolve()
      expect(await decision).toBe(next)
      expect(await freshSlot({
        hydraId,
        project: {
          name: 'project',
          path: dir,
          detached: false,
        },
      })).toBe(third)
      expect(readFileSync(
        marker,
        'utf8',
      )).toBe('Work saved by the competing start')
    } finally {
      queue.release.resolve()
      await Promise.allSettled([decision])
      unclaim({ path: occupied })
      unclaim({ path: next })
      unclaim({ path: third })
    }
  },
)
