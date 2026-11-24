import type { TitanState, SourceRef } from '#app/model.ts'
import type { AgentSession } from '#workers/model.ts'
import { sameSource, isStaleSource } from './events.ts'
import { observesPresence, sessionId } from '#workers/session-attachments.ts'

export interface SourceObservation {
  cardId: string
  source: SourceRef
  at: string
}

export const observationKey = ({
  cardId,
  source,
}: Pick<SourceObservation, 'cardId' | 'source'>) =>
  [
    cardId,
    source.adapter,
    source.instanceId ?? '',
    source.objectId,
  ].join('\0')

export const sourceFacts = ({ refs }: { refs: SourceRef[] }) => refs.map(source => ({
  adapter: source.adapter,
  instanceId: source.instanceId ?? '',
  objectId: source.objectId,
  generation: source.generation ?? 0,
  cursor: source.cursor,
}))

export function sessionFacts({ session }: { session: AgentSession | undefined }) {
  if (!session) {
    return undefined
  }

  const facts = { ...session }
  delete facts.lastSeen

  return {
    ...facts,
    sourceRefs: sourceFacts({ refs: session.sourceRefs }),
  }
}

// Source timestamps order incoming reports; advancing them changes neither task revision nor its Activity.
export function applyObservation({
  state,
  observation,
}: {
  state: TitanState
  observation: SourceObservation
}): void {
  const {
    cardId,
    source,
    at,
  } = observation
  const card = state.cards[cardId]

  if (!card || isStaleSource({
    card,
    source,
  })) {
    return
  }

  const update = ({ refs }: { refs: SourceRef[] }) => refs.map(known => sameSource({
    a: known,
    b: source,
  }) ? {
      ...known,
      ...source,
    } : known)
  card.sourceRefs = update({ refs: card.sourceRefs })
  const session = card.agent && state.sessions?.[sessionId({ agent: card.agent })]

  if (!session) {
    return
  }

  if (observesPresence({
    adapter: source.adapter,
    lastSeen: session.lastSeen,
  })
    && (!session.lastSeen || at > session.lastSeen)) {
    session.lastSeen = at
  }

  session.sourceRefs = update({ refs: session.sourceRefs })
  const target = session.taskId && state.cards[session.taskId]

  if (target && target !== card) {
    target.sourceRefs = update({ refs: target.sourceRefs })
  }
}
