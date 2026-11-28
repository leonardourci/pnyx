import { workerQueue } from '#workers/queue.ts'
import { handoffPending } from '#workers/handoff-checkout.ts'
import type { Card } from '#tasks/model.ts'
import { loadTitan } from '#app/store.ts'
import { settleCopy } from './copy-settle.ts'
import { trimPool } from './copy-pool.ts'
import { doneSince } from '#tasks/delivery/model.ts'

// A task in Done whose agent is still working keeps its copy until the agent stops.
export const settles = ({ card }: { card: Card }) => Boolean(doneSince({ card })) && card.copy?.state === 'active'
  && card.activity !== 'working'

export async function settleDone({
  titanId,
  at = new Date().toISOString(),
}: {
  titanId: string
  at?: string
}): Promise<number> {
  const state = loadTitan({ titanId }).state

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
      titanId,
      task: card.id,
    })
  })

  for (const card of due) {
    await settleCopy({
      titanId,
      ref: card.id,
      meta: {
        actor: 'othrys',
        at,
      },
    })
  }

  await trimPool({ titanId })

  return due.length
}
