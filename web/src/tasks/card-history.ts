import { useEffect, useState } from 'react'
import type { ErroredQuery, ResultType } from '@rocicorp/zero'
import type { HydraEvent } from '#app/model.ts'
import { queries } from '#store/zero-schema.ts'
import type { TaskEvent } from '#tasks/updates.ts'
import { pageZero } from '#web-app/zero.ts'

export interface CardHistory {
  events: TaskEvent[]
  loaded: boolean
  error?: string
}

const toTaskEvent = ({ event }: { event: HydraEvent }): TaskEvent => ({
  id: event.id,
  seq: event.seq,
  at: event.at,
  type: event.type,
  actor: event.actor,
  reason: event.reason,
  details: event.details,
  data: event.data as Record<string, unknown>,
})

// A card's Updates, newest first, as Zero syncs them: the events its card.history rows list.
export function useCardHistory({
  hydraId,
  cardId,
}: {
  hydraId: string
  cardId: string
}): CardHistory {
  const [
    history,
    setHistory,
  ] = useState<CardHistory>({
    events: [],
    loaded: false,
  })

  useEffect(
    () => {
      const zero = pageZero()

      if (!zero) {
        return
      }

      const view = zero.materialize(queries.card.history({
        hydraId,
        cardId,
      }))
      view.addListener((
        rows,
        resultType: ResultType,
        error?: ErroredQuery,
      ) => setHistory({
        // A row whose event Zero has not synced yet shows once it has.
        events: rows.flatMap(row => row.event
          ? [toTaskEvent({ event: row.event.data as HydraEvent })]
          : []),
        loaded: resultType === 'complete' || resultType === 'cached',
        error: resultType === 'error' ? error?.message ?? 'Zero could not read these updates' : undefined,
      }))

      return () => view.destroy()
    },
    [
      hydraId,
      cardId,
    ],
  )

  return history
}
