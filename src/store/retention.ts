import { hydraEvent } from '../core/hydra.ts'
import { DEFAULT_DONE_HOURS, doneDeadline, HOUR_MS } from '../core/retention.ts'
import { loadHydra, withWriter } from './hydra-store.ts'

export function hideDone({ hydraId, at = new Date().toISOString() }: {
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
      const hours = writer.state.config?.doneAfterHours ?? DEFAULT_DONE_HOURS
      let hidden = 0

      for (const card of Object.values(writer.state.cards)) {
        if (!hours || card.hidden || card.keepDone || !card.doneAt
          || Date.parse(card.doneAt) + hours * HOUR_MS > now) {
          continue
        }

        const decision = hydraEvent({ state: writer.state, meta: { actor: 'pnyx', at }, cardId: card.id, change: { type: 'task.visibility', data: { before: false, after: true, automatic: true } } })

        if ('event' in decision) {
          writer.append({ event: decision.event })
          hidden++
        }
      }

      return hidden
    },
  })
}
