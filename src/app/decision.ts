import { isDeepStrictEqual } from 'node:util'
import type { HydraState, HydraEvent, Decision } from './model.ts'
import type { PushedEvent } from '#tasks/model.ts'
import type { Meta } from './command-meta.ts'
import type { Writer } from './writer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { requireReportReview } from '#investigations/inventory.ts'
import { checkRevision, strip } from '#tasks/push-rules.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { observationKey, sessionFacts } from '#tasks/observations.ts'
import { reduce } from './reducer.ts'

const REPORT_LIMIT = 200
const REPORT_MAX_BYTES = 64 * 1024
interface LastReport {
  report: unknown
  revision: number
  session: string
}
const lastReports = new WeakMap<HydraState, Map<string, LastReport>>()

const sessionSignature = ({
  state,
  event,
}: {
  state: HydraState
  event: PushedEvent
}) => {
  const agent = event.data.agent ?? state.cards[event.cardId]?.agent
  const session = agent ? state.sessions?.[sessionId({ agent })] : undefined
  const target = session?.taskId ? state.cards[session.taskId] : undefined

  return JSON.stringify({
    facts: sessionFacts({ session }),
    targetRevision: target?.revision,
  })
}

const reportCache = ({ state }: { state: HydraState }) => {
  let cache = lastReports.get(state)

  if (!cache) {
    cache = new Map()
    lastReports.set(
      state,
      cache,
    )
  }

  return cache
}

const observation = ({ event }: { event: PushedEvent }): Decision => ({
  skipped: 'unchanged',
  observation: {
    cardId: event.cardId,
    source: event.data.source!,
    at: event.at,
  },
})

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
  const repeated = event.type === 'card.pushed' && event.data.source
  const cache = reportCache({ state })
  const key = repeated ? observationKey({
    cardId: event.cardId,
    source: event.data.source!,
  }) : undefined
  const report = event.type === 'card.pushed' ? reportOf({ event }) : undefined
  const last = key ? cache.get(key) : undefined

  if (event.type === 'card.pushed' && last && last.revision === card?.revision
    && last.session === sessionSignature({
      state,
      event,
    }) && isDeepStrictEqual(
    last.report,
    report,
  )) {
    return observation({ event })
  }

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

  if (event.type !== 'card.pushed' && before && isDeepStrictEqual(
    before,
    after,
  ) && isDeepStrictEqual(
    state.sessions,
    reduced.sessions,
  )) {
    return { skipped: 'unchanged' }
  }

  if (event.type === 'card.pushed' && event.data.source && key) {
    const session = sessionSignature({
      state: reduced,
      event,
    })

    const bytes = Buffer.byteLength(JSON.stringify(report)) + Buffer.byteLength(session)

    if (bytes <= REPORT_MAX_BYTES) {
      cache.delete(key)
      cache.set(
        key,
        {
          report,
          revision: reduced.cards[event.cardId]?.revision ?? 0,
          session,
        },
      )

      if (cache.size > REPORT_LIMIT) {
        cache.delete(cache.keys().next().value!)
      }
    }
  }

  return { event }
}

export function applyDecision({
  writer,
  decision,
}: {
  writer: Writer
  decision: Decision
}): void {
  if ('observation' in decision && decision.observation) {
    writer.observe({ observation: decision.observation })
  }

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}
