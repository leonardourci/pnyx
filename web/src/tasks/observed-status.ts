import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { cardStatus, type CardStatus } from '#tasks/card-status.ts'
import { knownCards } from '#tasks/select.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { PendingTurn } from '#web-workers/pending-turns.ts'

export interface ObservedStatus extends CardStatus {
  details: string
}

export function observedStatus({
  card,
  state,
  action,
  pending,
}: {
  card?: Card
  state?: HydraState
  action?: CurrentAction
  pending?: PendingTurn
}): ObservedStatus {
  if (pending?.error) {
    return {
      kind: 'error',
      text: pending.error,
      details: pending.error,
    }
  }

  const active = (card?.sessionActivity ?? card?.activity) === 'working'

  if (pending && !active) {
    return {
      kind: 'working',
      state: 'working',
      text: 'starting…',
      details: 'starting…',
    }
  }

  if (!card) {
    return {
      kind: 'not-started',
      text: 'not started',
      details: 'not started',
    }
  }

  const status = cardStatus({
    card,
    cards: state && knownCards({ state }),
  })

  const startingSession = active && status.kind === 'not-started'

  if (status.kind === 'working' || startingSession) {
    const tools = hasRunningTools({
      action,
      workingSince: card.workingSince,
    })
    const text = tools ? 'working' : 'thinking'

    return {
      ...status,
      kind: 'working',
      state: 'working',
      text,
      details: text,
    }
  }

  return {
    ...status,
    details: status.text,
  }
}

function hasRunningTools({
  action,
  workingSince,
}: {
  action?: CurrentAction
  workingSince?: string
}): boolean {
  if (action?.work) {
    return action.work.runningTools.length > 0
  }

  if (!action || action.done || !action.calls.length) {
    return false
  }

  const transcriptPredatesTurn = action.at !== undefined && workingSince !== undefined
    && Date.parse(action.at) < Date.parse(workingSince)

  return !transcriptPredatesTurn
}
