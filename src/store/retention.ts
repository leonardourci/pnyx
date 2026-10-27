import { reportReviewGaps } from '../investigation/inventory.ts'
import { hydraEvent } from '../core/hydra.ts'
import { cardDoneDeadline, doneDeadline } from '../core/retention.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter } from '../app/writer.ts'

export function hideDone({
  hydraId,
  at = new Date().toISOString(),
}: {
  hydraId: string
  at?: string
}): number {
  const deadline = doneDeadline({ state: loadHydra({ hydraId }).state })
  const now = Date.parse(at)

  if (deadline === undefined || deadline > now) {
    return 0
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      let hidden = 0

      for (const card of Object.values(writer.state.cards)) {
        if (reportReviewGaps({
          state: writer.state,
          card,
        }).length) {
          continue
        }

        const deadline = cardDoneDeadline({
          card,
          hours: writer.state.config?.doneAfterHours,
        })

        if (deadline === undefined || deadline > now) {
          continue
        }

        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'pnyx',
            at,
          },
          cardId: card.id,
          change: {
            type: 'task.visibility',
            data: {
              before: false,
              after: true,
              automatic: true,
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
          hidden++
        }
      }

      return hidden
    },
  })
}
