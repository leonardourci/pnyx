import { hydraEvent } from '#titan/titan.ts'
import { cardDoneDeadline, doneDeadline } from './retention-rules.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { readSettings } from '#settings/store.ts'

export async function hideDone({
  titanId,
  at = new Date().toISOString(),
}: {
  titanId: string
  at?: string
}): Promise<number> {
  const hours = readSettings().settings.doneAfterHours
  const deadline = doneDeadline({
    state: loadTitan({ titanId }).state,
    hours,
  })
  const now = Date.parse(at)

  if (deadline === undefined || deadline > now) {
    return 0
  }

  return await withWriter({
    titanId,
    fn: ({ writer }) => {
      let hidden = 0

      for (const card of Object.values(writer.state.cards)) {
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
            actor: 'othrys',
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
