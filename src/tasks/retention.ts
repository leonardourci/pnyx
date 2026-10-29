import { reportReviewGaps } from '#investigations/inventory.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { cardDoneDeadline, doneDeadline } from './retention-rules.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { readSettings } from '#settings/store.ts'

export function hideDone({
  hydraId,
  at = new Date().toISOString(),
}: {
  hydraId: string
  at?: string
}): number {
  const hours = readSettings().settings.doneAfterHours
  const deadline = doneDeadline({
    state: loadHydra({ hydraId }).state,
    hours,
  })
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
          hours,
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
