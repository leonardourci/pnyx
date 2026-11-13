import type { HydraState, SourceRef } from '#app/model.ts'
import type { AgentSession } from '#workers/model.ts'
import type { Statement } from '#store/postgres.ts'
import { sameSource, isStaleSource } from './events.ts'
import { sessionId } from '#workers/session-attachments.ts'

export interface SourceObservation {
  cardId: string
  source: SourceRef
  at: string
}

export interface ObservationRow {
  card_id: string
  adapter: string
  instance_id: string
  object_id: string
  generation: number
  observed_at: string
  seen_at: string
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
  state: HydraState
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

  if (!session.lastSeen || at > session.lastSeen) {
    session.lastSeen = at
  }

  session.sourceRefs = update({ refs: session.sourceRefs })
  const target = session.taskId && state.cards[session.taskId]

  if (target && target !== card) {
    target.sourceRefs = update({ refs: target.sourceRefs })
  }
}

export function restoreObservations({
  state,
  rows,
}: {
  state: HydraState
  rows: ObservationRow[]
}): void {
  for (const row of rows) {
    const known = state.cards[row.card_id]?.sourceRefs.find(source => source.adapter === row.adapter
      && (source.instanceId ?? '') === row.instance_id && source.objectId === row.object_id)

    if (!known) {
      continue
    }

    const source = {
      ...known,
      observedAt: row.observed_at,
    }

    if (row.generation !== (known.generation ?? 0)) {
      source.generation = row.generation
    }

    applyObservation({
      state,
      observation: {
        cardId: row.card_id,
        source,
        at: row.seen_at,
      },
    })
  }
}

export function observationStatement({
  hydraId,
  observation,
}: {
  hydraId: string
  observation: SourceObservation
}): Statement {
  const { source } = observation

  return {
    text: `insert into source_observations
      (hydra_id, card_id, adapter, instance_id, object_id, generation, observed_at, seen_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (hydra_id, card_id, adapter, instance_id, object_id) do update
      set generation = excluded.generation, observed_at = excluded.observed_at, seen_at = excluded.seen_at
      where (source_observations.generation, source_observations.observed_at)
        <= (excluded.generation, excluded.observed_at)`,
    values: [
      hydraId,
      observation.cardId,
      source.adapter,
      source.instanceId ?? '',
      source.objectId,
      source.generation ?? 0,
      source.observedAt ?? observation.at,
      observation.at,
    ],
  }
}
