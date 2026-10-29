import { isDeepStrictEqual } from 'node:util'
import type { HydraState, HydraEvent, Decision, SourceRef } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { observedBefore, sameSource } from '#tasks/events.ts'
import type { Meta } from './command-meta.ts'
import { hydraConfig } from '#hydra/config.ts'
import { requireReportReview } from '#investigations/inventory.ts'
import { checkRevision, strip } from '#tasks/push-rules.ts'
import { reduce } from './reducer.ts'

// A push that only moves its source's observation time is logged once per heartbeat; any other change
// is logged at once. A quiet worker's lastSeen lags its newest observation by at most this, well inside STALL_MS.
export const OBSERVATION_HEARTBEAT_MS = 60_000

// ponytail: kept in memory, so a restart forgets skipped observations and an older one drained from the
// spool after it can still apply; persist the newest per source if that ever matters.
const skippedObservations = new Map<string, SourceRef>()

const observationKey = ({
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

// An observation older than a repeat skipped for this card's source is stale, as it would be had the repeat been logged.
export function behindSkipped({
  cardId,
  source,
}: {
  cardId: string
  source: SourceRef
}): boolean {
  const skipped = skippedObservations.get(observationKey({
    cardId,
    source,
  }))

  return !!skipped && observedBefore({
    source,
    known: skipped,
  })
}

const untimedRefs = ({ refs }: { refs: SourceRef[] }) => refs.map(ref => ({
  ...ref,
  observedAt: undefined,
}))

const untimedCard = ({ card }: { card: Partial<Card> }) => ({
  ...card,
  sourceRefs: untimedRefs({ refs: card.sourceRefs ?? [] }),
})

const untimedSessions = ({ sessions }: { sessions: HydraState['sessions'] }) => Object.fromEntries(
  Object.entries(sessions ?? {}).map(([
    id,
    session,
  ]) => [
    id,
    {
      ...session,
      lastSeen: undefined,
      sourceRefs: untimedRefs({ refs: session.sourceRefs }),
    },
  ]),
)

const heartbeatDue = ({
  card,
  source,
  at,
}: {
  card: Card
  source: SourceRef
  at: string
}) => {
  const logged = card.sourceRefs.find(ref => sameSource({
    a: ref,
    b: source,
  }))?.observedAt ?? card.updatedAt
  const quietFor = Date.parse(source.observedAt ?? at) - Date.parse(logged)

  return Number.isNaN(quietFor) || quietFor >= OBSERVATION_HEARTBEAT_MS
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

  if (!card || !before || !after) {
    return { event }
  }

  const unchanged = isDeepStrictEqual(
    before,
    after,
  ) && isDeepStrictEqual(
    state.sessions,
    reduced.sessions,
  )

  if (unchanged) {
    return { skipped: 'unchanged' }
  }

  const source = event.type === 'card.pushed' ? event.data.source : undefined

  if (!source || heartbeatDue({
    card,
    source,
    at: event.at,
  })) {
    return { event }
  }

  const sameCard = isDeepStrictEqual(
    untimedCard({ card: before }),
    untimedCard({ card: after }),
  )
  const sameSessions = isDeepStrictEqual(
    untimedSessions({ sessions: state.sessions }),
    untimedSessions({ sessions: reduced.sessions }),
  )

  if (sameCard && sameSessions) {
    skippedObservations.set(
      observationKey({
        cardId: card.id,
        source,
      }),
      source,
    )

    return { skipped: 'unchanged' }
  }

  return { event }
}
