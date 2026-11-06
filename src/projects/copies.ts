import { workerQueue } from '#workers/queue.ts'
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

  if (state.config?.hydra.kind === 'firstmate') {
    return 0
  }

  const due = Object.values(state.cards).filter(card => settles({ card })
    && !workerQueue({
      state,
      session: card.sessionIds?.[0] ?? '',
    }).length)

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
