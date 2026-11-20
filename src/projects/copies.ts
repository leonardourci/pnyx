import { workerQueue } from '#workers/queue.ts'
import { handoffPending } from '#workers/handoff-checkout.ts'
import type { Card } from '#tasks/model.ts'
import { loadHydra } from '#app/store.ts'
import { settleCopy } from './copy-settle.ts'
import { trimPool } from './copy-pool.ts'

// A task in Done whose agent is still working keeps its copy until the agent stops.
// An investigation keeps its copy, so the worker that becomes its build resumes in the same folder.
export const settles = ({ card }: { card: Card }) => Boolean(card.doneAt) && card.copy?.state === 'active'
  && card.activity !== 'working' && card.kind !== 'investigation'

export async function settleDone({
  hydraId,
  at = new Date().toISOString(),
}: {
  hydraId: string
  at?: string
}): Promise<number> {
  const state = loadHydra({ hydraId }).state

  const due = Object.values(state.cards).filter(card => {
    if (!settles({ card })) {
      return false
    }

    const queued = workerQueue({
      state,
      session: card.sessionIds?.[0] ?? '',
    }).length > 0

    // An unresolved handoff refuses settlement until restart recovery, so it must not stop the other copies settling.
    return !queued && !handoffPending({
      hydraId,
      task: card.id,
    })
  })

  for (const card of due) {
    await settleCopy({
      hydraId,
      ref: card.id,
      meta: {
        actor: 'pnyx',
        at,
      },
    })
  }

  await trimPool({ hydraId })

  return due.length
}
