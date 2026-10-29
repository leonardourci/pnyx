import { isDeepStrictEqual } from 'node:util'
import type { HydraState, HydraEvent, Decision, SourceRef } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { sessionId } from '#workers/session-attachments.ts'
import type { Meta } from './command-meta.ts'
import { hydraConfig } from '#hydra/config.ts'
import { requireReportReview } from '#investigations/inventory.ts'
import { checkRevision, strip } from '#tasks/push-rules.ts'
import { reduce } from './reducer.ts'

// A push that only moves an observation's time is logged once per heartbeat, which keeps a quiet
// worker's lastSeen far inside STALL_MS; a push that changes anything else is always logged.
export const OBSERVATION_HEARTBEAT_MS = 60_000

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
  state,
  card,
  at,
}: {
  state: HydraState
  card: Card
  at: string
}) => {
  const session = card.agent && state.sessions?.[sessionId({ agent: card.agent })]
  const seen = session?.lastSeen || card.updatedAt
  const quietFor = Date.parse(at) - Date.parse(seen)

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
  const onlyObservedLater = event.type === 'card.pushed' && isDeepStrictEqual(
    untimedCard({ card: before }),
    untimedCard({ card: after }),
  ) && isDeepStrictEqual(
    untimedSessions({ sessions: state.sessions }),
    untimedSessions({ sessions: reduced.sessions }),
  ) && !heartbeatDue({
    state,
    card,
    at: event.at,
  })

  return unchanged || onlyObservedLater ? { skipped: 'unchanged' } : { event }
}
