import { isDeepStrictEqual } from 'node:util'
import type { HydraState, HydraEvent, Decision, SourceRef } from './model.ts'
import type { ObservedEvent, PushedEvent } from '#tasks/model.ts'
import type { Meta } from './command-meta.ts'
import { hydraConfig } from '#hydra/config.ts'
import { requireReportReview } from '#investigations/inventory.ts'
import { checkRevision, strip } from '#tasks/push-rules.ts'
import { reduce } from './reducer.ts'

// ponytail: the last full push from each card's source, kept in memory; after a restart the first
// repeat of each source is logged in full again, which costs bytes, never correctness.
const lastReports = new Map<string, {
  report: unknown
  id: string
}>()

const reportKey = ({
  cardId,
  source,
}: {
  cardId: string
  source: SourceRef
}) => [
  cardId,
  source.adapter,
  source.instanceId,
  source.objectId,
].join('\0')

// Everything a push reports except when it was made and the derived `before` values.
const reportOf = ({ event }: { event: PushedEvent }) => ({
  ...event,
  id: undefined,
  seq: undefined,
  at: undefined,
  commandId: undefined,
  data: {
    ...event.data,
    before: undefined,
    source: {
      ...event.data.source,
      observedAt: undefined,
    },
  },
})

// A push that reports exactly what its source's last full push reported is logged as the new
// observation time alone, but only when that leaves the card and sessions exactly as the full push would.
function compacted({
  state,
  event,
  reduced,
}: {
  state: HydraState
  event: PushedEvent
  reduced: HydraState
}): Decision {
  const { source } = event.data

  if (!source) {
    return { event }
  }

  const key = reportKey({
    cardId: event.cardId,
    source,
  })
  const report = reportOf({ event })
  const last = lastReports.get(key)

  if (last && isDeepStrictEqual(
    last.report,
    report,
  )) {
    const observed = {
      ...event,
      reason: undefined,
      details: undefined,
      type: 'card.observed',
      data: {
        source,
        of: last.id,
      },
    } as ObservedEvent
    const result = reduce({
      state: {
        ...state,
        eventIds: {},
      },
      event: observed,
    })
    const sameCard = isDeepStrictEqual(
      result.cards[event.cardId],
      reduced.cards[event.cardId],
    )
    const sameSessions = isDeepStrictEqual(
      result.sessions,
      reduced.sessions,
    )

    if (sameCard && sameSessions) {
      return { event: observed }
    }
  }

  lastReports.set(
    key,
    {
      report,
      id: event.id,
    },
  )

  return { event }
}

export function decided({
  state,
  meta,
  event,
}: {
  state: HydraState
  meta: Meta
  event: HydraEvent
}): Decision {
  if (event.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const card = state.cards[event.cardId]
  const movedToDone = event.type === 'card.moved'
    && hydraConfig({ state }).columns.find(column => column.id === event.data.after)?.role === 'done'
  const completed = event.type === 'card.outcome' && event.data.after?.state === 'done'

  if (card && (movedToDone || completed)) {
    requireReportReview({
      state,
      card,
    })
  }

  checkRevision({
    card: state.cards[event.cardId],
    ifRevision: meta.ifRevision,
  })
  const before = strip({ card: state.cards[event.cardId] })
  // The reducer reads eventIds only for the duplicate check above; cloning them is half of each decision's cost.
  const reduced = reduce({
    state: {
      ...state,
      eventIds: {},
    },
    event,
  })
  const after = strip({ card: reduced.cards[event.cardId] })

  if (before && isDeepStrictEqual(
    before,
    after,
  ) && isDeepStrictEqual(
    state.sessions,
    reduced.sessions,
  )) {
    return { skipped: 'unchanged' }
  }

  return event.type === 'card.pushed' ? compacted({
    state,
    event,
    reduced,
  }) : { event }
}
