import type { Card, Column, HydraState, TaskStatus } from './model.ts'
import { HYDRA_CARD, hydraConfig, roleColumn } from './hydra.ts'
import { INTERRUPTED } from './tasks.ts'

type Stage = 'in_progress' | 'needs_you' | 'done'

const MOVE = ':lifecycle'

// A lifecycle move is known by its id; hydra check leaves it out, since it lists the change that caused it.
export const lifecycleMoveId = ({
  event,
  cardId,
}: {
  event: string
  cardId: string
}) => `${event}:${cardId}${MOVE}`
export const lifecycleMove = ({ id }: { id: string }) => id.endsWith(MOVE)

// An open request or question the owner has to answer, or a worker's own needs_you or blocked
// declaration. A question still waiting on Hydra is not one.
export function asksOwner({ card }: { card: Card }): boolean {
  return card.attention.some(a => a.blocking && !a.answered)
    || !!card.permissions?.some(p => p.status === 'pending')
    || !!card.asks?.some(a => a.audience === 'owner' && !a.answered)
    || card.status?.state === 'needs_you' || card.status?.state === 'blocked'
}

const DECLARED: Partial<Record<TaskStatus, Stage>> = {
  working: 'in_progress',
  done: 'done',
}

const ASKED: Partial<Record<TaskStatus, string>> = {
  needs_you: 'Declared needs you',
  blocked: 'Declared blocked',
}

// A turn the server cut short waits for someone to continue it, not for the owner's answer.
const waitsOnOwner = ({ card }: { card: Card }) => asksOwner({
  card: {
    ...card,
    attention: card.attention.filter(a => a.key !== INTERRUPTED),
  },
})

// The column role a task's explicit signals call for. Agent activity, a finished turn,
// silence or an ended session never count; paused and undeclared tasks call for none.
export function lifecycleStage({ card }: { card: Card }): Stage | undefined {
  if (waitsOnOwner({ card })) {
    return 'needs_you'
  }

  return card.status && DECLARED[card.status.state]
}

const moveReason = ({
  card,
  stage,
  answered,
}: {
  card: Card
  stage: Stage | 'queued'
  answered: boolean
}) => {
  if (stage === 'needs_you') {
    return (card.status && ASKED[card.status.state]) ?? 'Waiting for the owner'
  }

  if (answered) {
    return 'Answered'
  }

  return stage === 'done' ? 'Declared done' : 'Declared working'
}

// The moves one event's stage changes call for. Only a change moves a card, so a manual move
// holds until the next one. A task in a column without a role stays where the owner put it, and
// a Firstmate-linked Hydra leaves placement to its sync.
export function lifecycleMoves({
  before,
  state,
}: {
  before: HydraState
  state: HydraState
}): {
  cardId: string
  column: Column
  reason: string
}[] {
  if (state.config?.hydra.kind === 'firstmate') {
    return []
  }

  const columns = hydraConfig({ state }).columns

  return Object.values(state.cards).flatMap(card => {
    const previous = before.cards[card.id]

    const placed = columns.find(c => c.id === card.column)

    if (!previous || card.automaticTask || card.id === HYDRA_CARD || !placed?.role) {
      return []
    }

    const was = lifecycleStage({ card: previous })
    // An answered ask on a task that never declared returns it to its worker, or to the queue without one.
    const answered = was === 'needs_you' && !waitsOnOwner({ card }) && previous.status?.id === card.status?.id
    const back = card.sessionIds?.length ? 'in_progress' : 'queued'
    const stage = lifecycleStage({ card }) ?? (answered && !card.status ? back : undefined)
    const column = stage && stage !== was && roleColumn({
      columns,
      role: stage,
    })

    if (!column || column === card.column) {
      return []
    }

    return [
      {
        cardId: card.id,
        column,
        reason: moveReason({
          card,
          stage,
          answered,
        }),
      },
    ]
  })
}
