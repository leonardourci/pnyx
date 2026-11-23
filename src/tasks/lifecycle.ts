import { ownerGates } from './owner-gates.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Column } from './columns-model.ts'
import type { Card } from './model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { cardFacts, placeCard } from './columns.ts'
import { isManagedTask } from './select.ts'

type Stage = 'queued' | 'in_progress' | 'needs_you' | 'parked' | 'done'

const MOVE = ':lifecycle'

export const lifecycleMoveId = ({
  event,
  cardId,
}: {
  event: string
  cardId: string
}) => `${event}:${cardId}${MOVE}`

// A question still waiting on Hydra does not count as waiting on the owner.
function asksOwner({ card }: { card: Card }): boolean {
  return ownerGates({ card }).length > 0
}

const moveReason = ({
  stage,
  answered,
  facts,
}: {
  facts: ReturnType<typeof cardFacts>
  stage: Stage
  answered: boolean
}) => {
  if (stage === 'needs_you') {
    return 'Waiting for the owner'
  }

  if (answered) {
    return 'Answered'
  }

  if (stage === 'queued') {
    if (facts.includes('held')) {
      return 'Held for discussion'
    }

    return facts.includes('queued') ? 'Queued behind a worker' : 'Waiting for a worker'
  }

  if (stage === 'parked') {
    return facts.includes('worker:ended') ? 'Worker ended with unfinished work' : 'Worker paused'
  }

  return stage === 'done' ? 'Task completed' : 'Worker update'
}

// A manual move holds until a change selects a different rule destination.
export function lifecycleMoves({
  before,
  state,
  event,
}: {
  before: HydraState
  state: HydraState
  event?: HydraEvent
}): {
  cardId: string
  column: Column
  reason: string
}[] {
  const migrating = event?.type === 'board.columns' && event.actor === 'pnyx'

  const reminderUpdate = event?.type === 'task.reminder-due' && event.data.column === undefined

  if (migrating || reminderUpdate) {
    return []
  }

  const columns = hydraConfig({ state }).columns

  return Object.values(state.cards).flatMap(card => {
    const previous = before.cards[card.id]

    const unmanaged = !state.configured && card.tracking !== 'declared'

    if (isManagedTask({ card }) || unmanaged
      || (!previous && event?.type !== 'task.created')) {
      return []
    }

    if (event?.type === 'board.columns' && event.data.placements?.[card.id]) {
      return []
    }

    if (!previous && event?.type === 'task.created' && event.data.column && !card.hold) {
      return []
    }

    const facts = cardFacts({
      card,
      state,
    })
    const column = placeCard({
      card: facts,
      columns,
    })
    const previousColumn = previous && placeCard({
      card: cardFacts({
        card: previous,
        state: before,
      }),
      columns: hydraConfig({ state: before }).columns,
    })

    if (!column || column === card.column || column === previousColumn) {
      return []
    }

    const answered = !!previous && asksOwner({ card: previous }) && !asksOwner({ card })
    const destination = columns.find(c => c.id === column)!
    const stage = destination.role
    const reason = stage && stage !== 'workers_on_it'
      ? moveReason({
        stage,
        answered,
        facts,
      }) : `Column rule matched: ${destination.title}`

    return [
      {
        cardId: card.id,
        column,
        reason,
      },
    ]
  })
}

export function pausedDeclaration({ card }: { card: Card }) {
  const declaration = card.status

  if (declaration?.state !== 'paused') {
    return undefined
  }

  return card.statusLog?.find(s => s.id === declaration.restores && s.state === 'paused') ?? declaration
}
