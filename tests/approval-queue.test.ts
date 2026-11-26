import { expect, test, vi } from 'vitest'
import { recoverOwnerCommands } from '#app/confirmations.ts'
import { emptyTitan } from '#app/reducer.ts'
import type { Writer } from '#app/writer.ts'

const queue = vi.hoisted(() => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}))
const loaded = emptyTitan()
const current = emptyTitan()
const append = vi.fn()

vi.mock(
  '#app/store.ts',
  () => ({ loadTitan: () => ({ state: loaded }) }),
)
vi.mock(
  '#app/writer.ts',
  () => ({
    withWriter: async ({ fn }: { fn({ writer }: { writer: Writer }): unknown }) => {
      queue.entered.resolve()
      await queue.release.promise

      return fn({
        writer: {
          state: current,
          dir: '',
          append,
          observe: () => {},
          afterCommit: () => {},
        },
      })
    },
  }),
)

test(
  'queued owner command recovery fails only approvals still applying when its write runs',
  async () => {
    loaded.dispatchProposals = [
      {
        token: 'completed-command',
        kind: 'command',
        shared: false,
        before: '',
        value: '',
        summary: 'Completed while recovery waited',
        status: 'applying',
      },
    ]
    loaded.dispatchProposals.push({
      ...loaded.dispatchProposals[0]!,
      token: 'still-applying-command',
    })
    current.dispatchProposals = []
    const recovery = recoverOwnerCommands({ titanId: 'queued-approval' })

    try {
      const phase = await Promise.race([
        queue.entered.promise.then(() => 'waiting'),
        recovery,
      ])
      expect(phase).toBe('waiting')
      current.dispatchProposals = [
        {
          ...loaded.dispatchProposals[0]!,
          status: 'failed',
        },
        ...loaded.dispatchProposals.slice(1),
      ]
      queue.release.resolve()
      await recovery
      expect(append).toHaveBeenCalledTimes(1)
      expect(append).toHaveBeenCalledWith({
        event: expect.objectContaining({
          type: 'titan.dispatch-progress',
          data: expect.objectContaining({
            token: 'still-applying-command',
            status: 'failed',
          }),
        }),
      })
    } finally {
      queue.release.resolve()
      await Promise.allSettled([recovery])
    }
  },
)
